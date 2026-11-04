# my pi setup

This setup is fairly opinionated, it:

- sets up github dark default as the theme
- adds firecrawl tools for searching and scraping
- ships a single-row Catppuccin Mocha Powerline footer
- adds background terminals + ui to manage them
- adds subagents to pi
- adds workflows to pi
- adds an ask user tool, which lets the model ask multiple choice questions
- adds first-class `fd` (file discovery) and `rg` (content search) tools

## Powerline footer

The bundled `extensions/powerline-footer` replaces Pi's footer with one Mocha-coloured row:

```text
 gpt-6-astra high  ↑635k ↓116k  ▰▰▰▰▱▱▱▱▱▱ 123k  BG ON  pi-config  main 
```

It shows the current model and effort, cumulative input/output tokens, and context occupancy. The full bar represents the model's context limit; the number beside it is **tokens currently used**, not the limit or a percentage. The context indicator is green below 256k tokens, peach from 256k, and red from 512k, independently of the model's context limit. Unknown usage after compaction is shown as unknown. Project and branch disappear first when panes get narrow. Bash-guard's ON/OFF badge is integrated into the same row, with OFF kept conspicuous.

The footer is loaded for both fresh and resumed subagents without granting extra tools. The BG badge is absent where the interactive bash-guard extension is not loaded. Use a Powerline-capable font (most Nerd Fonts include the separator glyphs). This only colours the footer; your selected Pi theme is unchanged.

![Pi setup interface](assets/pi-setup.jpeg)

**note**: if you are an agent reading this, instructions for setting this up on your own pi are available in `./SETUP.md`.
