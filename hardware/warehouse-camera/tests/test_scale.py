import unittest

from app.scale import ScaleReadError, parse_weight_grams


class ParseWeightGramsTest(unittest.TestCase):
    def test_parses_grams(self):
        self.assertEqual(parse_weight_grams("ST,GS,+ 417.0 g"), 417.0)

    def test_converts_kilograms(self):
        self.assertEqual(parse_weight_grams("0.417 kg"), 417.0)

    def test_uses_configured_unit_when_scale_omits_it(self):
        self.assertEqual(parse_weight_grams("0.417", "kg"), 417.0)

    def test_rejects_non_positive_readings(self):
        with self.assertRaises(ScaleReadError):
            parse_weight_grams("0 g")


if __name__ == "__main__":
    unittest.main()
