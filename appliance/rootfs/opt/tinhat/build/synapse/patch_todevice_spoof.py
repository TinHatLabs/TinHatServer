"""Synapse 1.145.0 with one upstream security fix backported (applied to the image's own file by its Dockerfile).

Upstream GHSA-rgv2-84w7-5j9p, fixed in Synapse 1.157.2 (element-hq/synapse 51988c5): a to-device EDU whose `sender`
isn't on the server that sent it was logged as "Dropping device message ... with spoofed sender" and then delivered
anyway (handlers/devicemessage.py, on_direct_to_device_edu: the `if` had no `return`). Any server we federate with
could send to-device messages (verification requests, key and secret requests) in the name of anyone, including
our own people. The fix is upstream's own: `return` right after the warning.

Usage: patch_todevice_spoof.py PATH/TO/synapse/handlers/devicemessage.py
Exits non-zero, changing nothing, unless the warning block has exactly the 1.145 shape: a Synapse upgrade must drop this patch
(1.157.2 and later carry the fix), never stack it on code it wasn't written for.
"""
import sys

BUGGY = '''        if origin != get_domain_from_id(sender_user_id):
            logger.warning(
                "Dropping device message from %r with spoofed sender %r",
                origin,
                sender_user_id,
            )
        message_type = content["type"]
'''
FIXED = '''        if origin != get_domain_from_id(sender_user_id):
            logger.warning(
                "Dropping device message from %r with spoofed sender %r",
                origin,
                sender_user_id,
            )
            return
        message_type = content["type"]
'''
UPSTREAM_FIXED = '''                sender_user_id,
            )
            return
'''


def patch(text: str) -> str:
    if text.count(BUGGY) == 1:
        return text.replace(BUGGY, FIXED)
    if UPSTREAM_FIXED in text:
        raise SystemExit("devicemessage.py already drops spoofed senders (Synapse 1.157.2+): remove this patch")
    raise SystemExit("devicemessage.py isn't the Synapse 1.145 code this patch was written for: refusing")


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        raise SystemExit(__doc__)
    path = argv[1]
    with open(path, encoding="utf-8") as f:
        text = f.read()
    out = patch(text)
    with open(path, "w", encoding="utf-8") as f:
        f.write(out)
    print(f"patched {path}: to-device messages with a spoofed sender are dropped")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
