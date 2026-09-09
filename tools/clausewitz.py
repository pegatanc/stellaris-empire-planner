"""Parser for Paradox Clausewitz script (.txt) and localisation (.yml) files.

Kept separate from extract.py so the parser can be exercised on its own; run this
file directly for a self-check.
"""
from __future__ import annotations

import re
from collections import OrderedDict

_TOK = re.compile(
    r'''
      [ \t\r\n]+
    | \#[^\n]*
    | "(?:[^"\\]|\\.)*"
    | [{}]
    | >=|<=|!=|==|=|>|<
    | [^\s{}=<>#"]+
    ''',
    re.X,
)

_SKIP = re.compile(r'^[ \t\r\n]|^#')

_OPS = ("=", "==", ">=", "<=", "!=", ">", "<")


class Block:
    """An ordered multimap. Paradox files repeat keys (`value = a` `value = b`)
    and also hold bare list entries (`initializers = { a b }`), so neither a dict
    nor a list alone models one."""

    __slots__ = ("items", "bare")

    def __init__(self):
        self.items = []   # list[(key, op, value)]
        self.bare = []    # list[str]

    def get(self, key, default=None):
        for k, _op, v in self.items:
            if k == key:
                return v
        return default

    def all(self, key):
        return [v for k, _op, v in self.items if k == key]

    def keys(self):
        return [k for k, _op, _v in self.items]

    def __repr__(self):
        return f"Block({self.items!r}, bare={self.bare!r})"


def _unquote(tok):
    if len(tok) >= 2 and tok[0] == '"' and tok[-1] == '"':
        body = tok[1:-1]
        return body.replace('\\"', '"').replace('\\\\', '\\')
    return tok


def tokenize(text):
    out = []
    pos, end = 0, len(text)
    while pos < end:
        m = _TOK.match(text, pos)
        if not m:
            # Unparseable byte (stray quote, control char). Skip it rather than
            # abandoning the file - Paradox ships a few of these.
            pos += 1
            continue
        pos = m.end()
        tok = m.group(0)
        if _SKIP.match(tok):
            continue
        out.append(tok)
    return out


def parse(text):
    """Parse a whole file into a top-level Block."""
    if text and text[0] == "﻿":
        text = text[1:]
    toks = tokenize(text)
    block, _idx = _parse_block(toks, 0, top=True)
    return block


def _parse_block(toks, i, top=False):
    blk = Block()
    n = len(toks)
    while i < n:
        tok = toks[i]
        if tok == "}":
            if top:
                i += 1          # stray closer; ignore and keep going
                continue
            return blk, i + 1
        if tok == "{":
            # Anonymous sub-block used as a list element, e.g. inside `variables`.
            sub, i = _parse_block(toks, i + 1)
            blk.items.append(("", "=", sub))
            continue
        # Look ahead for an operator to tell key=value from a bare list entry.
        if i + 1 < n and toks[i + 1] in _OPS:
            key = _unquote(tok)
            op = toks[i + 1]
            i += 2
            if i >= n:
                break
            if toks[i] == "{":
                val, i = _parse_block(toks, i + 1)
            else:
                val = _unquote(toks[i])
                i += 1
            blk.items.append((key, op, val))
        else:
            blk.bare.append(_unquote(tok))
            i += 1
    return blk, i


def to_obj(block, resolve=None, drop=()):
    """Convert a Block to plain JSON-safe data.

    Repeated keys collapse to a list; a single occurrence stays scalar, so the
    consumer normalises with an `arr()` helper. `resolve` maps @scripted_variable
    references onto their values.
    """
    acc = OrderedDict()
    for key, op, val in block.items:
        if key in drop:
            continue
        if isinstance(val, Block):
            out = to_obj(val, resolve=resolve, drop=drop)
        else:
            out = resolve_scalar(val, resolve)
        if op != "=":
            out = {"__op": op, "__v": out}
        acc.setdefault(key, []).append(out)
    obj = {k: (v[0] if len(v) == 1 else v) for k, v in acc.items()}
    if block.bare:
        obj["__list"] = [resolve_scalar(b, resolve) for b in block.bare]
    return obj


def resolve_scalar(val, resolve):
    if not resolve or not isinstance(val, str):
        return val
    if val.startswith("@"):
        return resolve.get(val, val)
    if val.startswith("-@"):
        inner = resolve.get(val[1:])
        if inner is not None:
            try:
                return numstr(-float(inner))
            except (TypeError, ValueError):
                return val
    return val


def numstr(f):
    return str(int(f)) if f == int(f) else str(f)


# --------------------------------------------------------------------------
# Localisation (.yml) - deliberately NOT parsed as YAML. Values contain raw
# unescaped quotes, so we take everything between the first quote and the last.
# --------------------------------------------------------------------------

_LOC_LINE = re.compile(r'^\s*([A-Za-z0-9_.\-\']+):(\d*)\s*"(.*)"\s*$')


def parse_loc(text):
    out = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        m = _LOC_LINE.match(line.rstrip())
        if m:
            out[m.group(1)] = m.group(3)
            continue
        # Trailing comment after the closing quote.
        hash_pos = line.rfind('#')
        if hash_pos > 0:
            m = _LOC_LINE.match(line[:hash_pos].rstrip())
            if m:
                out[m.group(1)] = m.group(3)
    return out


def _selfcheck():
    src = (
        '# comment with " quote and { brace\n'
        'civic_x = {\n'
        '    cost = 2\n'
        '    potential = { ethics = { NOT = { value = ethic_a } } }\n'
        '    possible = {\n'
        '        ethics = { value = ethic_b value = ethic_c }\n'
        '        num_things >= 1\n'
        '    }\n'
        '    initializers = { sys_a sys_b }\n'
        '    swap_type = { name = "A" }\n'
        '    swap_type = { name = "B" }\n'
        '    weight = @my_var\n'
        '    negweight = -@my_var\n'
        '    desc = "text with # hash inside"\n'
        '}\n'
    )
    blk = parse(src)
    civic = blk.get("civic_x")
    assert civic is not None, "top-level entry missing"
    obj = to_obj(civic, resolve={"@my_var": "7"})

    assert obj["cost"] == "2"
    # repeated key -> list, single key -> scalar
    assert isinstance(obj["swap_type"], list) and len(obj["swap_type"]) == 2
    assert obj["swap_type"][0]["name"] == "A"
    # repeated `value` inside one block must both survive
    assert obj["possible"]["ethics"]["value"] == ["ethic_b", "ethic_c"]
    # nested operators
    assert obj["potential"]["ethics"]["NOT"]["value"] == "ethic_a"
    # bare list entries
    assert obj["initializers"]["__list"] == ["sys_a", "sys_b"]
    # a non-'=' operator is preserved rather than silently flattened
    assert obj["possible"]["num_things"] == {"__op": ">=", "__v": "1"}
    # scripted variable resolution, both signs
    assert obj["weight"] == "7"
    assert obj["negweight"] == "-7"
    # a '#' inside a string is not a comment
    assert obj["desc"] == "text with # hash inside", obj["desc"]

    # A quote inside a loc value must not truncate it.
    loc = parse_loc(
        '﻿l_english:\n'
        ' civic_x:0 "Say §Y"hi"§! now"\n'
        ' bare_key: "no version"\n'
        ' commented:0 "value" # trailing note\n'
        ' # comment\n'
    )
    assert loc["civic_x"] == 'Say §Y"hi"§! now', loc["civic_x"]
    assert loc["bare_key"] == "no version"
    assert loc["commented"] == "value"

    print("clausewitz selfcheck OK")


if __name__ == "__main__":
    _selfcheck()
