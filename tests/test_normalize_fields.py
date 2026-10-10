"""Unit tests for the capability input-schema normalizer.

The fleet heartbeats TWO schema dialects (live-verified 2026-10-07 via the
node_capabilities index on the relay):
- Relay-native:  {"fields": {name: {name, type, required, description, …}}}
  — what most nodes emit (e.g. Node-23A).
- JSON-Schema:   {"type": "object", "properties": {name: {type, description}},
  "required": [names]} — what JSON-Schema-speaking nodes emit (e.g. Node-31B).

dashboard/plugin_api._normalize_fields maps both to the TaskForm dialect;
caps that genuinely take no input ({"fields": {}}) must stay empty so the
form renders its Advanced-JSON-only mode.
"""

import importlib
import pathlib
import sys

import pytest

_HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent / "dashboard"))
nf = importlib.import_module("plugin_api")._normalize_fields


RELAY_DIALECT = {
    "fields": {
        "prompt": {
            "name": "prompt", "type": "string", "required": True,
            "description": "ask",
        }
    }
}

JSON_SCHEMA_DIALECT = {
    "type": "object",
    "properties": {
        "command": {
            "type": "string",
            "description": "The command to execute.",
        }
    },
    "required": ["command"],
}

JSON_SCHEMA_MULTI = {
    "type": "object",
    "properties": {
        "prompt": {"type": "string", "description": "T"},
        "steps": {"type": "integer", "default": 4},
        "hd": {"type": "boolean"},
    },
    "required": ["prompt"],
}


def test_relay_dialect_passes_through():
    out = nf(RELAY_DIALECT)
    assert out == {
        "prompt": {"name": "prompt", "type": "string", "required": True,
                   "description": "ask"}
    }


def test_json_schema_dialect_maps_to_fields():
    out = nf(JSON_SCHEMA_DIALECT)
    assert out == {
        "command": {"name": "command", "type": "string", "required": True,
                    "description": "The command to execute."}
    }


def test_json_schema_types_required_default():
    out = nf(JSON_SCHEMA_MULTI)
    assert out["prompt"]["required"] is True
    assert out["steps"]["type"] == "integer"
    assert out["steps"]["example"] == 4
    assert out["steps"].get("required") is None
    assert out["hd"]["type"] == "boolean"
    assert "required" not in out["hd"]


def test_zero_input_and_garbage_stay_empty():
    assert nf({"fields": {}}) == {}
    assert nf(None) == {}
    assert nf("nope") == {}
    assert nf({"type": "object"}) == {}


def test_property_without_type_defaults_to_string():
    out = nf({"type": "object", "properties": {"x": {}}, "required": ["x"]})
    assert out == {"x": {"name": "x", "type": "string", "required": True}}