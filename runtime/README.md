# runtime

The process a systemd unit starts: the release loop, the reply tool, the teaching tools, the tool-server launcher, the adapter registry, the per-adapter lock and the terminal latch.

An email channel's persisted poll block carries `inbound_transport`. The value
is `imap` for the compatible default or the declaration's explicit inbound
transport. Doctor and install use that provenance to distinguish current poll
evidence from state left by a transport the declaration no longer uses.
