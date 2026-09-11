# The directory a thread opens on, and what the harness still reads from it

**Question.** A turn that runs one local command dies in bubblewrap before the
shell starts, because the sandbox has to be able to create `cwd/.git` and the
checkout is read-only with no `.git` in it. If the thread opens on the work
directory instead, does the shell run — and does the agent still get the guidance
and the skills the harness used to load out of the checkout?

**Answer.** Yes to both. The shell runs, and the guidance and skills load because
`AGENTS.md` and `.agents/` are written into the work directory from the checkout
at every start. Neither is read from anywhere but the thread's `cwd` on the pinned
binary, which is the reason they are placed at all, and that was measured rather
than assumed. They are copies and not symlinks, which took a second live probe to
learn: the sandbox binds the guidance read-only inside the turn, and bubblewrap
cannot bind a path that is a symlink into a read-only tree.

Two halves: what `codex-cli 0.153.4` reads out of a `cwd`, measured on a
development machine on 11 September 2026 with no model called at all; and one
agent on a real box, answering a message, running a command and quoting its own
guidance.

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
thread off the checkout without placing them would silently produce an agent with
no guidance and no skills. A symlink satisfies this half — it was the first shape
the runtime shipped, in 0.5.4 — and half three is where it stops being enough.

## Half two: the sandbox mount point, on the box

Run on a Debian aarch64 client box as the unprivileged operating login, outside
any turn, in the shape the harness's Linux sandbox runs:

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

## Half three: a symlink is not enough

0.5.4 shipped the links and was installed on a client box. A probe asking for one
local command — `ls <checkout>` — came back with one line and no command item on
the turn:

```
Unable to list entries: the required command failed because the sandbox could not
enforce the read-only path <work>/.agents across a writable symlink.
```

The harness binds the guidance read-only inside the turn's namespace. Reproduced
on the box outside any turn, with the checkout read-only and `.agents` a symlink
into it:

```
$ bwrap --dev-bind / / --remount-ro / --bind <work> <work> \
        --ro-bind-try <work>/.agents <work>/.agents --chdir <work> /bin/true
bwrap: Can't bind mount /oldroot/<checkout>/.agents on /newroot/<work>/.agents:
       Unable to mount source on destination: No such file or directory
```

Bubblewrap resolves the source outside the namespace and then cannot find the
destination inside it. The same command with `.agents` a real directory exits 0,
and so does the same command against `.agents/skills` when the whole tree is real.
Which of the two the harness binds was never established, and does not need to be:
what stands at those names in the work directory is real, at every level, and a
symlink the client repository itself carries is resolved on the way in.

So 0.5.5 writes both names as real files and real directories, from the checkout,
at every start of the runtime. An install always restarts the unit, so the copy
cannot drift from what was installed, and nothing a turn writes over them outlives
the run.

## Half four: a live agent, on a real box

One more thing had to change before this could be proved rather than believed. A
shell command is an item on the completed turn and not a tool call, so the turn's
log line — which carried the tool names — said nothing about whether a command had
run. A turn whose shell died in the sandbox and a turn that chose to run nothing
logged the same empty list, which is why PA-181 was invisible until a probe was
written to catch it. 0.5.6 puts one entry per command on that line: working
directory, status and exit code, never the command text.

With 0.5.6 installed, a probe sent to the agent's mailbox asking for one local
command, `ls <checkout>`, read only:

```
AGENTS.md
README.md
carbon.agent.json
cases
config
docs
evidence
hooks
references
tools
```

and the turn's own log line:

```
"status":"completed",
"tool_calls":[{"server":"carbon-reply","tool":"reply","status":"failed"},
              {"server":"carbon-reply","tool":"reply","status":"completed"}],
"commands":[{"cwd":"<work>","status":"completed","exit_code":0},
            {"cwd":"<work>","status":"completed","exit_code":0}]
```

The shell ran, in the work directory, and exited 0. The listing is the checkout's
own, read by absolute path from a directory the thread is no longer opened on.

A second probe, asking what the agent's own `AGENTS.md` says it must never do and
which stage skills it is carrying, with no tool call and no command allowed:

```
Production remains read-only.
<six stage skills, by name>
```

Both come out of the checkout, through the copies in the work directory. Guidance
and skills load, the shell runs, and the checkout is still read-only and still
carries no `.git`.

`carbon doctor` against the box after the install: reachable, 21 of 21 contract
checks pass, no drifts, assessment clean.

