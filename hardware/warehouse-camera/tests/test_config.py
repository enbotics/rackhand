import os
import unittest
from unittest.mock import patch

from app.config import get_bool


class GetBoolTest(unittest.TestCase):
    def test_uses_default_when_missing(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(get_bool("SCALE_ENABLED", False))

    def test_accepts_enabled_and_disabled_values(self):
        for value, expected in (("true", True), ("1", True), ("false", False), ("0", False)):
            with self.subTest(value=value), patch.dict(
                os.environ,
                {"SCALE_ENABLED": value},
                clear=True,
            ):
                self.assertEqual(get_bool("SCALE_ENABLED", True), expected)

    def test_rejects_invalid_value(self):
        with patch.dict(os.environ, {"SCALE_ENABLED": "automatic"}, clear=True):
            with self.assertRaises(RuntimeError):
                get_bool("SCALE_ENABLED", True)


if __name__ == "__main__":
    unittest.main()
