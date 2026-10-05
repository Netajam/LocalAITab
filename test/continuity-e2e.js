const { chatStream, chatWithTools, getCapabilities } = require('../out/core/llm/ollama');
const M = 'qwen2.5-coder:7b-instruct';
const SYS = 'You are a coding assistant. Be brief.';

const T1 = 'I am refactoring a class called CompletionCache. Remember that name.';
const T2 = 'What is the name of the class I told you I am refactoring?';

(async () => {
  const caps = await getCapabilities('http://localhost:11434', M);
  const think = caps.includes('thinking') ? false : undefined;

  // --- chat mode, with history (what the code does) ---
  const hist = [];
  for (const q of [T1, T2]) {
    const r = await chatStream({
      endpoint: 'http://localhost:11434', model: M,
      messages: [{ role: 'system', content: SYS }, ...hist, { role: 'user', content: q }],
      temperature: 0.2, maxTokens: 120, keepAlive: '30m',
      signal: new AbortController().signal, think, onToken: () => {},
    });
    hist.push({ role: 'user', content: q }, { role: 'assistant', content: r.text });
    if (q === T2) {
      console.log('chat WITH history:');
      console.log('  ', r.text.trim().slice(0, 140).replace(/\n/g, ' '));
      console.log('   remembered?', /CompletionCache/i.test(r.text) ? 'YES' : 'NO');
    }
  }

  // --- the old agent behaviour: no history passed ---
  const r2 = await chatStream({
    endpoint: 'http://localhost:11434', model: M,
    messages: [{ role: 'system', content: SYS }, { role: 'user', content: T2 }],
    temperature: 0.2, maxTokens: 120, keepAlive: '30m',
    signal: new AbortController().signal, think, onToken: () => {},
  });
  console.log('\nagent WITHOUT history (the bug):');
  console.log('  ', r2.text.trim().slice(0, 140).replace(/\n/g, ' '));
  console.log('   remembered?', /CompletionCache/i.test(r2.text) ? 'YES' : 'NO');

  // --- agent transport, history now supplied ---
  const r3 = await chatWithTools({
    endpoint: 'http://localhost:11434', model: M,
    messages: [{ role: 'system', content: SYS },
               { role: 'user', content: T1 }, { role: 'assistant', content: 'Noted: CompletionCache.' },
               { role: 'user', content: T2 }],
    tools: [], temperature: 0.2, maxTokens: 120, keepAlive: '30m',
    signal: new AbortController().signal, think,
  });
  console.log('\nagent WITH history (the fix):');
  console.log('  ', r3.content.trim().slice(0, 140).replace(/\n/g, ' '));
  console.log('   remembered?', /CompletionCache/i.test(r3.content) ? 'YES' : 'NO');
})();
