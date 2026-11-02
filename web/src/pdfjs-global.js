// pdf_viewer.mjs 要求先把 pdf.js 主库挂到 globalThis.pdfjsLib 上
import * as pdfjsLib from 'pdfjs-dist';

globalThis.pdfjsLib = pdfjsLib;
