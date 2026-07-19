"""Tests for the mention parser, including a ReDoS regression guard."""

import time

from webex_message_handler.mention_parser import parse_mentions


def test_empty_inputs():
    for v in (None, ""):
        r = parse_mentions(v)
        assert r.mentioned_people == []
        assert r.mentioned_groups == []


def test_single_person_mention():
    html = '<spark-mention data-object-type="person" data-object-id="uuid-1">Alice</spark-mention>'
    r = parse_mentions(html)
    assert r.mentioned_people == ["uuid-1"]
    assert r.mentioned_groups == []


def test_multiple_person_mentions_dedup():
    html = (
        '<spark-mention data-object-type="person" data-object-id="uuid-1">A</spark-mention>'
        '<spark-mention data-object-type="person" data-object-id="uuid-2">B</spark-mention>'
        '<spark-mention data-object-type="person" data-object-id="uuid-1">A</spark-mention>'
    )
    assert parse_mentions(html).mentioned_people == ["uuid-1", "uuid-2"]


def test_group_mention():
    html = '<spark-mention data-object-type="groupMention" data-group-type="all">All</spark-mention>'
    r = parse_mentions(html)
    assert r.mentioned_people == []
    assert r.mentioned_groups == ["all"]


def test_attribute_order_independent():
    html = (
        '<spark-mention data-object-id="uuid-9" data-object-type="person">X</spark-mention>'
        '<spark-mention data-group-type="all" data-object-type="groupMention">All</spark-mention>'
    )
    r = parse_mentions(html)
    assert r.mentioned_people == ["uuid-9"]
    assert r.mentioned_groups == ["all"]


def test_ignores_non_mention_html():
    r = parse_mentions("<p>hello <b>world</b></p>")
    assert r.mentioned_people == []
    assert r.mentioned_groups == []


def test_no_polynomial_backtracking_redos_guard():
    """Crafted input that made the old two-[^>]* regex backtrack must parse fast."""
    evil = "<spark-mention" + ' data-object-type="' * 50000
    start = time.monotonic()
    r = parse_mentions(evil)
    elapsed = time.monotonic() - start
    assert r.mentioned_people == []
    assert r.mentioned_groups == []
    assert elapsed < 1.0
