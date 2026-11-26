---
section: security
---

- **No look-alike member names.** Names are now compared as they look, so a name that differs from another member's only by full-width forms, look-alike letters (`AIice` for `Alice`) or Cyrillic and Greek letters that read as Latin is taken. Names with invisible or formatting characters (zero-width spaces, bidi controls) or mixing Latin with Greek or Cyrillic are refused, and names are stored in their normalised (NFKC) form.
