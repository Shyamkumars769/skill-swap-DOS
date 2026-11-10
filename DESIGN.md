# Skill Swap design notes

Warm cream ground, deep teal brand, coral accent, rounded cards (the original identity, refined).

- Teal = "I teach", coral = "I want to learn". Accent buttons use `--coral-d` so white text passes 4.5:1.
- No invented numbers, ratings or member counts anywhere in marketing copy; no emoji as icons.
- Every list page has loading, empty and error-with-retry states (`listLoading`, `listError` in app.js).
- Dialogs trap focus, close on Escape and return focus; toasts are aria-live; skip link and `aria-current` in the nav.
- Phones: sticky nav with sideways-scrolling links, chat sized with `dvh`. Reduced-motion is respected.
