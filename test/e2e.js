const { buildPrompt, postProcess, shouldBeMultiline, STOP_TOKENS } = require('../out/core/llm/fim');
const { generate } = require('../out/core/llm/ollama');

const MODEL = process.argv[2] || 'qwen2.5-coder:3b-base';

const CASES = [
  {
    name: 'python: fill a function body (multiline)',
    prefix: 'import json\n\ndef load_config(path):\n    """Read a JSON config file, returning {} if it is missing."""\n',
    suffix: '\n\ndef main():\n    cfg = load_config("app.json")\n',
    file: 'config.py',
  },
  {
    name: 'typescript: complete mid-line (single-line)',
    prefix: 'const users = [{ name: "a", age: 3 }, { name: "b", age: 9 }];\nconst names = users.map(',
    suffix: ');\nconsole.log(names);\n',
    file: 'users.ts',
  },
  {
    name: 'typescript: use a symbol from a neighbor file',
    prefix: 'import { DEFAULT_TIMEOUT } from "./consts";\n\nexport function makeClient() {\n  return new Client({ timeout: ',
    suffix: ' });\n}\n',
    file: 'client.ts',
    neighbors: [{ path: 'consts.ts', text: 'export const DEFAULT_TIMEOUT = 4200;' }],
  },
  {
    name: 'rust: complete a match arm (multiline)',
    prefix: 'fn describe(n: i32) -> &\'static str {\n    match n.cmp(&0) {\n',
    suffix: '    }\n}\n',
    file: 'lib.rs',
  },
];

(async () => {
  console.log(`\nmodel: ${MODEL}\n`);
  let ok = 0;

  for (const c of CASES) {
    const lineSuffix = c.suffix.split('\n')[0];
    const multiline = shouldBeMultiline(lineSuffix, 'auto');
    const prompt = buildPrompt({
      prefix: c.prefix,
      suffix: c.suffix,
      filePath: c.file,
      repoName: 'demo',
      neighbors: c.neighbors || [],
    });

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    try {
      const r = await generate({
        endpoint: 'http://localhost:11434',
        model: MODEL,
        prompt,
        temperature: 0.1,
        maxTokens: 256,
        keepAlive: '30m',
        stop: multiline ? STOP_TOKENS : [...STOP_TOKENS, '\n'],
        signal: ac.signal,
      });
      const text = postProcess(r.text, { suffix: c.suffix, multiline });

      console.log(`${c.name}`);
      console.log(`  mode=${multiline ? 'multi' : 'single'} ${r.totalMs}ms ${r.evalCount}tok`);
      console.log(text ? text.split('\n').map((l) => '  | ' + l).join('\n') : '  | <empty>');
      console.log();
      if (text) ok++;
    } catch (e) {
      console.log(`${c.name}\n  ERROR ${e.message}\n`);
    } finally {
      clearTimeout(timer);
    }
  }
  console.log(`${ok}/${CASES.length} produced a completion\n`);
})();
