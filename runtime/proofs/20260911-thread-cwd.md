# The directory a thread opens on, and what the harness still reads from it

**Question.** A turn that runs one local command dies in bubblewrap before the
shell starts, because the sandbox has to be able to create `cwd/.git` and the
checkout is read-only with no `.git` in it. If the thread opens on the work
directory instead, does the shell run — and does the agent still get the guidance
and the skills the harness used to load out of the checkout?

**Answer.** Yes to both. The shell runs, and the guidance and skills load because
`AGENTS.md` and `.agents/` are linked into the work directory from the checkout.
Neither is read from anywhere but the thread's `cwd` on the pinned binary, which
is the reason the links exist, and that was measured rather than assumed.

Two halves: what `codex-cli 0.153.4` reads out of a `cwd`, measured on the PcL
studio on 11 September 2026 with no model called at all; and one agent on a real
box, answering a message, running a command and quoting its own guidance.

## Half one: what the harness reads out of `cwd`

`codex debug prompt-input` renders the exact input list the model would be given,
without starting a turn, so this half costs nothing and is repeatable by anyone.

A scratch tree was built with the shape a box has — a checkout beside a work
directory — and the checkout was given an `AGENTS.md` carrying a sentinel string
and one skill whose description carried another:

```
<scratch>/current/repo/AGENTS.md                                (sentinel in the text)
<scratch>/current/repo/.agents/skills/sentinel-skill/SKILL.md   (sentinel in the description)
<scratch>/work/                                                 (empty)
```

Each case ran `codex debug prompt-input "hi"` with a private `CODEX_HOME`, from
the directory named, and the answer is whether each sentinel appears in the
rendered input:

| `cwd` | what is in `cwd` | `AGENTS.md` loaded | skill listed |
| --- | --- | --- | --- |
| the checkout | the real files | yes | yes |
| the work directory | nothing | **no** | **no** |
| the work directory | `AGENTS.md` symlinked to the checkout's | yes | no |
| the work directory | both symlinked to the checkout's | yes | yes |

So the harness reads both out of the thread's `cwd` and out of nowhere else: with
no `.git` anywhere above, there is no project root to walk up to, and moving the
thread off the checkout without the links would silently produce an agent with no
guidance and no skills. A symlink is enough, and it is what the runtime places, so
the bytes stay in the checkout install unpacked and `current` swinging is the only
thing that changes them.

## Half two: the sandbox mount point, on the box

Run on a Debian aarch64 client box as the PcL login, outside any turn, which is
the shape the harness's Linux sandbox runs:

```
$ mkdir -p /tmp/bwtest
$ bwrap --dev-bind / / --remount-ro / --bind /tmp/bwtest /tmp/bwtest \
        --ro-bind-try /tmp/bwtest/.git /tmp/bwtest/.git --chdir /tmp/bwtest /bin/true
exit=0
$ ls -a /tmp/bwtest
.
..
```

Two things. The bind succeeds where the same command against a read-only directory
fails with `bwrap: Can't mkdir <dir>/.git: Read-only file system`, which is the
PA-181 failure. And the mount point bubblewrap creates does not survive the
namespace: the work directory holds no `.git` afterwards, so HC-16 — nothing
install places is a clone — reads exactly as it did before.

## Half three: a live agent, on a real box
