import os
import re
import logging
import easyocr
import numpy as np
import fitz  # PyMuPDF untuk membaca PDF
from PIL import Image

# ==========================================
# LOGGING SETUP
# ==========================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s"
)
log = logging.getLogger("AI-OCR-VALIDATOR")

log.info("Memuat Engine EasyOCR (Memanfaatkan GPU RTX)...")
# Menggunakan Bahasa Indonesia (id) dan Inggris (en). gpu=True agar pakai RTX 3050!
reader = easyocr.Reader(['id', 'en'], gpu=True)
log.info("Engine EasyOCR Siap Digunakan!")

def extract_numbers(text):
    """Membersihkan teks dan mengambil semua kombinasi angka yang bernilai ribuan/jutaan"""
    # Hilangkan titik dan koma yang sering mengganggu pembacaan harga (misal Rp 15.000 jadi 15000)
    clean_text = text.replace('.', '').replace(',', '')
    # Cari semua kumpulan angka yang panjangnya minimal 3 digit (ratusan/ribuan)
    numbers = re.findall(r'\d{3,}', clean_text)
    return [int(num) for num in numbers]

def validate_receipt(dokumen_path, total_lapor_vendor):
    log.info("===================================================")
    log.info("AUDIT DOKUMEN OCR DIMULAI")
    log.info("File Dokumen : %s", dokumen_path)
    log.info("Target Angka : Rp %d", total_lapor_vendor)

    status_dokumen = "Membutuhkan Audit Manual"
    catatan = "Sistem gagal memverifikasi angka pada dokumen."

    parent_dir = os.path.dirname(os.getcwd())
    clean_dokumen_path = dokumen_path.lstrip('\\/')
    real_doc_path = os.path.join(parent_dir, 'backend', clean_dokumen_path)

    if not os.path.exists(real_doc_path):
        real_doc_path = os.path.join(os.getcwd(), clean_dokumen_path)

    if not os.path.exists(real_doc_path):
        log.error("File dokumen struk tidak ditemukan secara fisik.")
        return {"status": "File Error", "catatan": "File dokumen tidak ditemukan."}

    try:
        img_np = None

        # 1. JIKA FILE ADALAH PDF
        if real_doc_path.lower().endswith('.pdf'):
            log.info("Mengekstrak halaman pertama dari PDF...")
            doc = fitz.open(real_doc_path)
            page = doc.load_page(0) # Ambil halaman 1
            pix = page.get_pixmap(dpi=150) # Render jadi gambar
            
            # Konversi format PyMuPDF ke Numpy Array agar bisa dibaca EasyOCR
            img_np = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w, pix.n)
            
            # Jika PDF-nya punya channel alpha (RGBA), jadikan RGB
            if pix.n == 4:
                import cv2
                img_np = cv2.cvtColor(img_np, cv2.COLOR_RGBA2RGB)
                
        # 2. JIKA FILE ADALAH GAMBAR (JPG/PNG)
        else:
            log.info("Memuat file gambar...")
            import cv2
            img_np = cv2.imread(real_doc_path)
            img_np = cv2.cvtColor(img_np, cv2.COLOR_BGR2RGB)

        # ==========================================
        # PROSES PEMBACAAN OCR
        # ==========================================
        log.info("Menjalankan pemindaian OCR (Optical Character Recognition)...")
        # detail=0 berarti kita hanya butuh teksnya saja, tidak butuh koordinat kotaknya
        ocr_results = reader.readtext(img_np, detail=0) 
        
        semua_teks = " ".join(ocr_results).upper()
        log.info("Teks terbaca: %s...", semua_teks[:100]) # Tampilkan 100 huruf pertama saja di log

        # Ekstrak semua angka dari struk
        semua_angka = extract_numbers(semua_teks)
        
        # ==========================================
        # LOGIKA FORENSIK PENCOCOKAN HARGA
        # ==========================================
        if total_lapor_vendor <= 0:
            status_dokumen = "Menunggu Validasi"
            catatan = "Total lapor vendor Rp 0, tidak ada yang dicocokkan."
        elif not semua_angka:
            status_dokumen = "Indikasi Struk Kosong/Buram"
            catatan = "AI OCR tidak menemukan angka harga apapun di dalam dokumen."
        else:
            # Toleransi OCR (Kadang angka 8 terbaca 0, jadi kita kasih margin toleransi 2%)
            batas_bawah = total_lapor_vendor * 0.98
            batas_atas = total_lapor_vendor * 1.02
            
            match_found = False
            for angka in semua_angka:
                if batas_bawah <= angka <= batas_atas:
                    match_found = True
                    break
            
            if match_found:
                status_dokumen = "Struk Sah & Akurat"
                catatan = f"Total tagihan Rp{total_lapor_vendor} BERHASIL dibaca dan diverifikasi oleh OCR."
            else:
                status_dokumen = "Indikasi Struk Palsu / Mark-up"
                catatan = f"Angka Rp{total_lapor_vendor} TIDAK DITEMUKAN pada cetakan struk. Audit manual diperlukan!"

        log.info("Status Akhir Dokumen: %s", status_dokumen)

        return {
            "status": status_dokumen,
            "catatan": catatan
        }

    except Exception as e:
        log.error("Error sistem OCR: %s", str(e))
        return {"status": "Error", "catatan": str(e)}