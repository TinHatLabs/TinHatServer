"""Run by provision.sh inside the built (or reused) Synapse image (python - < this file): exits 1 unless the image's
own DeviceMessageHandler.on_direct_to_device_edu returns right after the spoofed-sender warning. It checks the code's
structure (ast), not text, so a comment or a string saying "return" never passes, and how the line is written doesn't
matter."""
import ast
import inspect
import sys
import textwrap

import synapse
from synapse.handlers.devicemessage import DeviceMessageHandler


def fixed(src: str) -> bool:
    fn = ast.parse(textwrap.dedent(src)).body[0]
    for node in ast.walk(fn):
        if not (isinstance(node, ast.If) and isinstance(node.test, ast.Compare)
                and isinstance(node.test.left, ast.Name) and node.test.left.id == "origin"
                and len(node.test.ops) == 1 and isinstance(node.test.ops[0], ast.NotEq)):
            continue
        body = node.body
        warns = (len(body) == 2 and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Call)
                 and "spoofed sender" in ast.dump(body[0].value))
        return warns and isinstance(body[1], ast.Return) and body[1].value is None
    return False


def main() -> int:
    if synapse.__version__ != "1.145.0":
        print(f"synapse image: {synapse.__version__}, not 1.145.0", file=sys.stderr)
        return 1
    if not fixed(inspect.getsource(DeviceMessageHandler.on_direct_to_device_edu)):
        print("synapse image without the to-device fix", file=sys.stderr)
        return 1
    print("synapse image: to-device fix present")
    return 0


if __name__ == "__main__":
    sys.exit(main())
