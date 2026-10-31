# voz-autocorrect

A [Voz](https://github.com/Joelheile/voz) extension that fixes words Voz keeps mishearing, and learns those fixes from you.

After each dictation it watches the text field until you send or clear it. When you correct a word, say `Phenom` to `Finom`, it remembers the pair. Once you made the same correction twice and hardly ever kept the word as dictated, it asks Claude Code whether this sounds like a recognition error or like you changed your mind. Recognition errors become a rule and Voz shows `Learned: phenom → Finom`. Later dictations get the fix before they are typed.

Rules replace whole words only. Unlike Voz's dictionary, they never bias the speech model, so they cannot turn similar sounding words into your names.

## Install

```
voz install voz-autocorrect
```

Needs Apple Silicon. Learning reads the focused text field through macOS accessibility, which Voz already has.

The confirmation step runs the [Claude Code](https://claude.com/claude-code) CLI on your Mac, signed in with your own Claude subscription or API key. Without it, or with confirmation turned off, every repeated correction that you rarely keep becomes a rule.

## Settings

- **Replacements**: your own rules, such as `Cloud=Claude; YFM=YFN`
- **Learn from my corrections**: on by default
- **Corrections before a rule is learned**: 2
- **Ask Claude Code before learning a rule**: sends only the word pair and one example sentence

Learned and rejected pairs are in `~/.voz/data/voz-autocorrect/learned.json`. Delete a rule there to undo it.

`edit-watch` is built from `edit-watch.swift`: `swiftc -O edit-watch.swift -o edit-watch`
