import io
import unittest
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
from app import convert


class ConversionTests(unittest.TestCase):
    def test_markdown_preserves_content(self):
        result = convert(b"# Synthetic heading\n\nTest body", "text/markdown")
        self.assertEqual(result["converter"], "markitdown")
        self.assertIn("Synthetic heading", result["pages"][0]["markdown"])

    def test_pdf_preserves_page_numbers(self):
        writer = PdfWriter()
        for text in ["Synthetic invoice page one", "Synthetic invoice page two"]:
            page = writer.add_blank_page(612, 792)
            font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
            page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
            stream = DecodedStreamObject()
            stream.set_data(f"BT /F1 12 Tf 50 700 Td ({text}) Tj ET".encode())
            page[NameObject("/Contents")] = writer._add_object(stream)
        data = io.BytesIO()
        writer.write(data)
        result = convert(data.getvalue(), "application/pdf")
        self.assertEqual([page["pageNumber"] for page in result["pages"]], [1, 2])
        self.assertIn("page two", result["pages"][1]["markdown"])

    def test_empty_pdf_does_not_report_ready(self):
        writer = PdfWriter()
        writer.add_blank_page(612, 792)
        data = io.BytesIO()
        writer.write(data)
        with self.assertRaises(ValueError):
            convert(data.getvalue(), "application/pdf")


if __name__ == "__main__":
    unittest.main()
