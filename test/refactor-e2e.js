const { chat, getCapabilities } = require('../out/core/llm/ollama');
const { cleanCode, matchIndentation } = require('../out/core/llm/extract');
const { SYSTEM_PROMPT, buildUserPrompt } = require('../out/hosts/app/refactor/prompts');

const MODEL = process.argv[2] || 'qwen2.5-coder:7b-instruct';

const CASES = [
  {
    name: 'python: simplify nested conditionals',
    languageId: 'python',
    filePath: 'auth.py',
    instruction: 'Simplify this code. Reduce nesting and remove redundancy. Behaviour must stay identical.',
    code: [
      'def can_access(user, doc):',
      '    if user is not None:',
      '        if user.active == True:',
      '            if doc.owner_id == user.id:',
      '                return True',
      '            else:',
      '                if user.is_admin == True:',
      '                    return True',
      '                else:',
      '                    return False',
      '        else:',
      '            return False',
      '    else:',
      '        return False',
    ].join('\n'),
  },
  {
    name: 'typescript: indented selection keeps its indentation',
    languageId: 'typescript',
    filePath: 'svc.ts',
    instruction: 'Add error handling for the realistic failure modes. Do not invent new dependencies.',
    code: [
      '    async function loadUser(id: string) {',
      '      const res = await fetch(`/api/users/${id}`);',
      '      return res.json();',
      '    }',
    ].join('\n'),
  },
];

(async () => {
  console.log(`\nrefactor model: ${MODEL}\n`);
  let ok = 0;

  for (const c of CASES) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 180000);
    try {
      const caps = await getCapabilities('http://localhost:11434', MODEL);
      const think = caps.includes('thinking') ? false : undefined;
      const res = await chat({
        endpoint: 'http://localhost:11434',
        model: MODEL,
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(c),
        temperature: 0.2,
        maxTokens: 2048,
        keepAlive: '30m',
        signal: ac.signal,
        think,
      });
      const out = matchIndentation(c.code, cleanCode(res.text));

      console.log(`${c.name}`);
      console.log(`  ${res.totalMs}ms ${res.evalCount}tok think=${think ?? 'n/a'}`);
      console.log(out.split('\n').map((l) => '  | ' + l).join('\n'));

      const problems = [];
      if (!out) problems.push('empty result');
      if (/^\s*(Sure|Here|Certainly|I )/i.test(out)) problems.push('leaked prose preamble');
      if (out.includes('```')) problems.push('leaked markdown fence');
      if (/<\/?think>/i.test(out)) problems.push('leaked reasoning tags');

      const origIndent = c.code.match(/^[ \t]*/)[0];
      const newIndent = out.match(/^[ \t]*/)[0];
      if (origIndent !== newIndent) problems.push(`indentation drift: ${JSON.stringify(origIndent)} -> ${JSON.stringify(newIndent)}`);

      if (problems.length) {
        console.log(`  PROBLEMS: ${problems.join('; ')}`);
      } else {
        console.log('  clean');
        ok++;
      }
      console.log();
    } catch (e) {
      console.log(`${c.name}\n  ERROR ${e.message}\n`);
    } finally {
      clearTimeout(timer);
    }
  }
  console.log(`${ok}/${CASES.length} clean\n`);
})();
