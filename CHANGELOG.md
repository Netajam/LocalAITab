# Changelog

## 0.12.0

- Refactor, chat and agent now default to `qwen2.5-coder:7b-instruct`, which
  runs on a 16 GB machine. The previous default, `qwen3.6:35b-a3b-coding`, needs
  about 32 GB; pick it with **LocalAITab: Select Model...** if you have the RAM.
  If you already set `localAITab.refactorModel`, nothing changes for you.

## 0.11.0

First Marketplace release.

- On-demand FIM completion against a local Ollama, manual by default.
- Refactor Selection and Make This Better, with a preview to apply or discard.
- Chat panel with explicit context, slash commands, skills and pinned selections.
- Agent and operator modes: staged edits, approved shell commands.
- Model picker that lists what Ollama has installed, and asks before running on
  a substitute when the instruct model is missing.
