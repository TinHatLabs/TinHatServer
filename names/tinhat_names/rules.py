"""Which names a server may take.

Plain lowercase letters, digits and dashes, 4–32 long, no Unicode look-alikes (no "xx--" punycode-style labels), and
nothing that reads as a well-known brand, a phishing word, a system or Tin Hat name, or a slur. Look-alikes are caught
by folding common character swaps (0→o, 1→l, 3→e, 4→a, 5→s, 7→t, 8→b, rn→m, vv→w) before comparing.

Names are never reused: once taken they stay taken, even after the server is gone (checked in the database, not here).
"""
import re

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$")

# Our own and infrastructure names. Exact match (a deployment adds its own in config.json's "reserved").
SYSTEM = {
    "www", "api", "names", "name", "admin", "administrator", "root", "abuse", "security", "support", "help", "status",
    "mail", "smtp", "imap", "pop", "mx", "ns", "ns1", "ns2", "dns", "ftp", "cdn", "static", "assets", "auth", "login",
    "account", "accounts", "billing", "pay", "payment", "register", "signup", "signin", "verify", "official", "staff",
    "team", "test", "demo", "example", "localhost", "matrix", "synapse", "element", "livekit", "turn", "stun",
    "tinhat", "tin-hat", "tinhats", "repo", "dev", "server", "servers", "www1", "web",
    "app", "apps", "home", "router", "update", "updates", "download", "downloads", "wallet",
}

# Brands people phish for. Any dash-separated part, or the whole name with dashes removed, matching one of these
# (after look-alike folding) is refused. Common words that are also brands (live, office, signal, epic, riot,
# minecraft …) are left out on purpose: friend groups name servers after their games.
BRANDS = {
    "paypal", "apple", "icloud", "microsoft", "outlook", "hotmail", "xbox", "google", "gmail", "youtube", "amazon",
    "aws", "netflix", "spotify", "steam", "steamcommunity", "valve", "discord", "twitch", "facebook", "instagram",
    "whatsapp", "messenger", "telegram", "twitter", "tiktok", "snapchat", "reddit", "github", "gitlab", "dropbox",
    "adobe", "slack", "linkedin", "yahoo", "aol", "ebay", "walmart", "costco", "bestbuy", "chase", "wellsfargo",
    "bankofamerica", "citi", "citibank", "capitalone", "amex", "americanexpress", "mastercard", "venmo", "cashapp",
    "zelle", "coinbase", "binance", "metamask", "trezor", "bitcoin", "ethereum", "usps", "fedex", "dhl", "irs",
    "medicare", "epicgames", "roblox", "mojang", "riotgames", "blizzard", "battlenet", "playstation", "nintendo",
    "ubisoft", "openai", "chatgpt", "anthropic", "cloudflare", "porkbun", "godaddy", "letsencrypt", "verizon",
    "tmobile", "xfinity", "comcast", "starlink",
}

# Words that turn a name into a lure when combined with anything ("crew-login" is fine to refuse).
PHISH = {"login", "logon", "signin", "verify", "verification", "secure", "security", "account", "wallet", "billing",
         "invoice", "refund", "support", "helpdesk", "recover", "recovery", "unlock", "update", "password", "2fa",
         "auth", "oauth", "sso", "bank", "banking", "payment", "giftcard", "airdrop", "claim", "free-nitro", "nitro"}

# Slurs and the like. Matched inside the folded name (the worst ones) or as a dash-separated part (the rest), to
# avoid refusing innocent names that merely contain a short word.
SEVERE = {"nigger", "nigga", "faggot", "kike", "chink", "spic", "tranny", "retard", "wetback", "gook", "coon"}
OFFENSIVE = {"fuck", "fucker", "shit", "cunt", "bitch", "whore", "slut", "porn", "rape", "rapist", "nazi", "hitler",
             "kkk", "cock", "dick", "pussy", "fag", "molest", "pedo", "cp", "csam", "incest"}

_FOLD = str.maketrans({"0": "o", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g", "@": "a", "$": "s"})


def fold(s: str) -> str:
    """Undo the usual look-alike swaps so 'paypa1' and 'rnicrosoft' compare equal to the real words ("1" reads as l)."""
    s = s.lower().translate(_FOLD).replace("1", "l")
    return s.replace("rn", "m").replace("vv", "w")


def folds(s: str) -> set[str]:
    """Every reading of an ambiguous swap: "1" can stand for l or i."""
    base = s.lower().translate(_FOLD)
    out = set()
    for one in ("l", "i"):
        v = base.replace("1", one)
        out |= {v, v.replace("rn", "m").replace("vv", "w")}
    return out


def check(name: str, reserved: frozenset[str] = frozenset()) -> tuple[bool, str, str]:
    """(ok, code, message for people). Codes: format, punycode, system, brand, phish, offensive. `reserved`: more
    names refused like the system ones (exact match), from the deployment's config."""
    n = (name or "").strip().lower()
    if not NAME_RE.match(n) or "--" in n:
        if len(n) > 3 and n[2:4] == "--":
            return False, "punycode", "Names can't use special characters. Use plain letters, numbers and dashes."
        return False, "format", "Use 4–32 letters, numbers or single dashes, starting and ending with a letter or number."
    if n in SYSTEM or n in reserved:
        return False, "system", "That name is reserved. Pick another one."
    parts = n.split("-")
    folded_parts = [f for p in parts for f in folds(p)]
    wholes = folds(n.replace("-", ""))
    whole = fold(n.replace("-", ""))
    if any(w in v for v in wholes for w in SEVERE) or any(p in OFFENSIVE for p in folded_parts):
        return False, "offensive", "Pick a different name."
    if any(p in BRANDS for p in folded_parts) or wholes & BRANDS:
        return False, "brand", "That looks like a well-known brand. Pick a name of your own."
    if any(p in SYSTEM for p in folded_parts) and any(p in PHISH for p in folded_parts):
        return False, "phish", "That name reads like a login or support page. Pick another one."
    if any(p in PHISH for p in folded_parts) and len(parts) > 1:
        return False, "phish", "That name reads like a login or support page. Pick another one."
    if any(b in v for v in wholes for b in BRANDS if len(b) >= 5) and any(w in whole for w in PHISH if len(w) >= 4):
        return False, "phish", "That name reads like a login or support page. Pick another one."
    return True, "ok", ""
