const assert = require('node:assert');
const { buildPrompt, postProcess, trimSuffixOverlap, shouldBeMultiline } = require('../out/core/llm/fim');
const { cleanCode, stripThinking, stripFences, matchIndentation } = require('../out/core/llm/extract');
const { buildUserPrompt } = require('../out/hosts/app/refactor/prompts');
const { isBaseTag, paramSize, chooseFallback, modelKind, suitsRole, partitionForRole } = require('../out/core/llm/modelselect');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

console.log('\ntrimSuffixOverlap');
t('strips a duplicated closing line', () => {
  assert.equal(trimSuffixOverlap('    return mid\n    return -1', '\n    return -1'), '    return mid');
});
t('strips duplicated closing brackets', () => {
  assert.equal(trimSuffixOverlap('foo(1))', ')'), 'foo(1)');
});
t('does NOT eat a digit that coincides with the suffix', () => {
  assert.equal(trimSuffixOverlap('x = 1', '1 + 2'), 'x = 1');
});
t('does NOT eat an identifier that coincides with the suffix', () => {
  assert.equal(trimSuffixOverlap('const a = b', 'b.c()'), 'const a = b');
});
t('leaves non-overlapping text alone', () => {
  assert.equal(trimSuffixOverlap('hello', '\nworld'), 'hello');
});

console.log('\npostProcess');
t('strips leaked control tokens', () => {
  assert.equal(postProcess('foo()<|endoftext|>', { suffix: '', multiline: true }), 'foo()');
});
t('truncates at newline in single-line mode', () => {
  assert.equal(postProcess('a = 1\nb = 2', { suffix: '', multiline: false }), 'a = 1');
});
t('keeps newlines in multiline mode', () => {
  assert.equal(postProcess('a = 1\nb = 2', { suffix: '', multiline: true }), 'a = 1\nb = 2');
});
t('drops whitespace-only output', () => {
  assert.equal(postProcess('   \n  ', { suffix: '', multiline: true }), '');
});
t('collapses a runaway blank-line tail', () => {
  assert.equal(postProcess('x = 1\n\n\n\n', { suffix: '', multiline: true }), 'x = 1\n');
});
t('removes a completion that only restates the suffix', () => {
  assert.equal(postProcess('\n    return -1', { suffix: '\n    return -1', multiline: true }), '');
});

console.log('\nshouldBeMultiline');
t('auto: yes at end of line', () => assert.equal(shouldBeMultiline('', 'auto'), true));
t('auto: yes with trailing whitespace', () => assert.equal(shouldBeMultiline('   ', 'auto'), true));
t('auto: yes above a closing brace', () => assert.equal(shouldBeMultiline('    }', 'auto'), true));
t('auto: yes above a closing call', () => assert.equal(shouldBeMultiline('  })', 'auto'), true));
t('auto: no when real code follows', () => assert.equal(shouldBeMultiline(');', 'auto'), false));
t('auto: no mid-expression', () => assert.equal(shouldBeMultiline('.length', 'auto'), false));
t('never overrides', () => assert.equal(shouldBeMultiline('', 'never'), false));
t('always overrides', () => assert.equal(shouldBeMultiline('.length', 'always'), true));

console.log('\nbuildPrompt');
t('bare prompt has no file separators', () => {
  const p = buildPrompt({ prefix: 'A', suffix: 'B', filePath: 'x.ts' });
  assert.equal(p, '<|fim_prefix|>A<|fim_suffix|>B<|fim_middle|>');
});
t('repo-level prompt puts the current file last', () => {
  const p = buildPrompt({
    prefix: 'A', suffix: 'B', filePath: 'cur.ts', repoName: 'demo',
    neighbors: [{ path: 'dep.ts', text: 'export const K = 1;' }],
  });
  assert.ok(p.startsWith('<|repo_name|>demo\n'));
  assert.ok(p.indexOf('<|file_sep|>dep.ts') < p.indexOf('<|file_sep|>cur.ts'));
  assert.ok(p.endsWith('<|fim_prefix|>A<|fim_suffix|>B<|fim_middle|>'));
});

console.log('\nstripThinking');
t('removes a closed reasoning block', () => {
  assert.equal(stripThinking('<think>hmm, maybe</think>\nconst a = 1;'), 'const a = 1;');
});
t('removes a dangling close tag and everything before it', () => {
  assert.equal(stripThinking('let me see</think>\nconst a = 1;'), 'const a = 1;');
});
t('leaves ordinary code untouched', () => {
  assert.equal(stripThinking('const a = 1;'), 'const a = 1;');
});

console.log('\nstripFences');
t('extracts the first fenced block', () => {
  assert.equal(stripFences('Here you go:\n```ts\nconst a = 1;\n```\nHope that helps'), 'const a = 1;\n');
});
t('handles a fence with no language tag', () => {
  assert.equal(stripFences('```\nconst a = 1;\n```'), 'const a = 1;\n');
});
t('leaves unfenced code alone', () => {
  assert.equal(stripFences('const a = 1;'), 'const a = 1;');
});

console.log('\ncleanCode');
t('strips reasoning, prose and fences together', () => {
  assert.equal(
    cleanCode('<think>ok</think>\nSure! Here is the result:\n```python\ndef f():\n    return 1\n```\n'),
    'def f():\n    return 1');
});
t('preserves leading indentation of the snippet', () => {
  assert.equal(cleanCode('```js\n    const a = 1;\n```'), '    const a = 1;');
});
t('preserves interior blank lines', () => {
  assert.equal(cleanCode('a = 1\n\nb = 2'), 'a = 1\n\nb = 2');
});

console.log('\nmatchIndentation');
t('restores an indent dropped from the first line only', () => {
  const orig = '    function f() {\n      return 1;\n    }';
  const res  = 'function f() {\n      return 1;\n    }';
  assert.equal(matchIndentation(orig, res), orig);
});
t('restores a uniformly dedented block', () => {
  const orig = '    function f() {\n      return 1;\n    }';
  const res  = 'function f() {\n  return 1;\n}';
  assert.equal(matchIndentation(orig, res), '    function f() {\n      return 1;\n    }');
});
t('leaves a correctly indented result alone', () => {
  const orig = '    a = 1\n    b = 2';
  const res  = '    a = 1\n    b = 3';
  assert.equal(matchIndentation(orig, res), res);
});
t('does nothing when the original was not indented', () => {
  assert.equal(matchIndentation('a = 1', 'b = 2\n  c = 3'), 'b = 2\n  c = 3');
});
t('preserves tabs rather than converting to spaces', () => {
  const orig = '\tfunction f() {\n\t\treturn 1;\n\t}';
  const res  = 'function f() {\n\treturn 1;\n}';
  assert.equal(matchIndentation(orig, res), '\tfunction f() {\n\t\treturn 1;\n\t}');
});
t('does not pad blank lines', () => {
  const orig = '    a = 1\n    b = 2';
  const res  = 'a = 1\n\nb = 2';
  assert.equal(matchIndentation(orig, res), '    a = 1\n\n    b = 2');
});

console.log('\nbuildUserPrompt');
t('includes language, instruction and code', () => {
  const p = buildUserPrompt({ languageId: 'rust', filePath: 'a.rs', instruction: 'simplify', code: 'fn x() {}' });
  assert.ok(p.includes('Language: rust'));
  assert.ok(p.includes('Instruction: simplify'));
  assert.ok(p.trimEnd().endsWith('fn x() {}'));
});
t('omits the context section when not supplied', () => {
  const p = buildUserPrompt({ languageId: 'rust', filePath: 'a.rs', instruction: 'x', code: 'y' });
  assert.ok(!p.includes('for reference only'));
});

console.log('\nchooseFallback');
t('prefers the first installed entry from the configured list', () => {
  const installed = ['qwen2.5-coder:3b-base', 'qwen2.5-coder:7b-instruct', 'llama3:8b'];
  assert.equal(
    chooseFallback(installed, ['qwen2.5-coder:14b-instruct', 'qwen2.5-coder:7b-instruct']),
    'qwen2.5-coder:7b-instruct');
});
t('skips configured fallbacks that are not installed', () => {
  const installed = ['qwen2.5-coder:3b-instruct'];
  assert.equal(chooseFallback(installed, ['not-installed:70b']), 'qwen2.5-coder:3b-instruct');
});
t('auto-picks the largest installed non-base model when no list matches', () => {
  const installed = ['qwen2.5-coder:3b-instruct', 'qwen2.5-coder:14b-instruct', 'qwen2.5-coder:7b-instruct'];
  assert.equal(chooseFallback(installed, []), 'qwen2.5-coder:14b-instruct');
});
t('biases towards coder tags over a larger general model', () => {
  const installed = ['llama3:70b', 'qwen2.5-coder:7b-instruct'];
  assert.equal(chooseFallback(installed, []), 'qwen2.5-coder:7b-instruct');
});
t('never picks a -base (FIM) tag', () => {
  assert.equal(chooseFallback(['qwen2.5-coder:3b-base'], []), undefined);
});
t('returns undefined when nothing is installed', () => {
  assert.equal(chooseFallback([], []), undefined);
});
t('reads total params, not the MoE active count, for a-tags', () => {
  assert.equal(paramSize('qwen3.6:35b-a3b-coding'), 35);
});
t('isBaseTag distinguishes base from instruct', () => {
  assert.equal(isBaseTag('qwen2.5-coder:3b-base'), true);
  assert.equal(isBaseTag('qwen2.5-coder:7b-instruct'), false);
});

console.log('\nworkspace path containment');
{
  const path = require('node:path');
  const ROOT = '/ws/proj';
  // Mirrors resolveInWorkspace in src/chat/tools.ts (which uses vscode.Uri.joinPath,
  // normalising ".." exactly as path.join does here).
  const resolve = (rel) => {
    if (!rel.trim()) return undefined;
    const cand = rel.startsWith('/')
      ? [path.normalize(rel), path.join(ROOT, rel.replace(/^\/+/, ''))]
      : [path.join(ROOT, rel)];
    const rootPath = ROOT.endsWith('/') ? ROOT : ROOT + '/';
    return cand.find((c) => c === ROOT || c.startsWith(rootPath));
  };

  const inside = [
    'src/cache.ts', './src/cache.ts', '/src/cache.ts',
    '/ws/proj/src/cache.ts', 'a/../b.ts',
  ];
  // The invariant that matters is not "was the string rejected" but "can this
  // ever name a file outside the workspace". A path that falls back to an
  // in-workspace interpretation is safe; it simply will not exist.
  const hostile = [
    '../../../etc/passwd', '../../.ssh/id_rsa', 'src/../../../etc/hosts',
    '..', '/etc/passwd', '/ws/other/secret.ts', '/ws/proj/../escape.ts',
    '....//....//etc/passwd', 'src/%2e%2e/%2e%2e/etc/passwd',
  ];

  for (const p of inside) {
    t(`allows ${p}`, () => assert.ok(resolve(p), `${p} should resolve`));
  }
  for (const p of hostile) {
    t(`never escapes: ${p}`, () => {
      const got = resolve(p);
      if (got === undefined) { return; }
      assert.ok(got === ROOT || got.startsWith(ROOT + '/'),
        `${p} resolved to ${got}, which is outside ${ROOT}`);
    });
  }
}

console.log('\nmodelKind');
t('a -base tag is a base model whatever it reports', () => {
  assert.equal(modelKind('qwen2.5-coder:1.5b-base', ['completion', 'insert']), 'base');
  assert.equal(modelKind('qwen2.5-coder:1.5b-base', []), 'base');
});
t('FIM without tools is a base model even without -base in the tag', () => {
  assert.equal(modelKind('starcoder2:3b', ['completion', 'insert']), 'base');
});
t('an instruct coder that also supports FIM stays instruct', () => {
  assert.equal(modelKind('qwen2.5-coder:7b-instruct', ['completion', 'insert', 'tools']), 'instruct');
});
t('a chat model is instruct', () => {
  assert.equal(modelKind('qwen3.6:35b-a3b-coding', ['completion', 'tools', 'thinking']), 'instruct');
});
t('with no capabilities reported, the tag decides', () => {
  assert.equal(modelKind('llama3:8b', []), 'instruct');
});
t('an embedding model is neither', () => {
  assert.equal(modelKind('nomic-embed-text:latest', ['embedding']), 'embedding');
});

console.log('\nsuitsRole / partitionForRole');
t('completion wants base, instruct roles want instruct', () => {
  assert.ok(suitsRole('completion', 'base'));
  assert.ok(!suitsRole('completion', 'instruct'));
  assert.ok(suitsRole('instruct', 'instruct'));
  assert.ok(!suitsRole('instruct', 'base'));
  assert.ok(!suitsRole('instruct', 'embedding') && !suitsRole('completion', 'embedding'));
});
t('partitions in installed order', () => {
  const models = [
    { tag: 'a:7b-instruct', kind: 'instruct' },
    { tag: 'b:3b-base', kind: 'base' },
    { tag: 'c:14b', kind: 'instruct' },
    { tag: 'embed', kind: 'embedding' },
  ];
  const { suited, others } = partitionForRole('instruct', models);
  assert.deepEqual(suited.map((m) => m.tag), ['a:7b-instruct', 'c:14b']);
  assert.deepEqual(others.map((m) => m.tag), ['b:3b-base', 'embed']);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
