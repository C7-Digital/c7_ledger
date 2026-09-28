# Project skills

Shared agent skills for this repository. Same `SKILL.md` format works in **Claude Code** and **Cursor**.

| Tool | Discovery path |
|------|----------------|
| Claude Code | `.claude/skills/<name>/SKILL.md` (this directory) |
| Cursor | `.cursor/skills/<name>/SKILL.md` (symlink → here) |

**Canonical copy** lives under `.claude/skills/`. Cursor reads a symlink at `.cursor/skills/` so both tools stay in sync without duplicating content.

On Windows, if symlinks are not checked out correctly, recreate:

```powershell
New-Item -ItemType Junction -Path .cursor\skills\<name> -Target .claude\skills\<name>
```
