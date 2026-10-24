"""0.3.1: servers on the federation list that are neither a Tin Hat connection nor allowed by name (put into state.json
by hand before the dashboard could allow a plain Matrix server) become servers allowed by name, before the update's
configs are written again: nothing on the list is dropped, and the dashboard shows them (Network → Other Matrix
servers) so the owner can remove them there."""
from tinhat import federation


def run() -> str:
    kept = federation.adopt()
    return f"kept {', '.join(kept)} as allowed by name" if kept else "nothing to adopt"
