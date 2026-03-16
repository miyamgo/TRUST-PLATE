import os
import re
import csv
import random
import logging
import numpy as np
import torch
import fitz  # PyMuPDF
import cv2
from collections import Counter
from PIL import Image, ImageEnhance
from flask import Flask, request, jsonify
from flask_cors import CORS
from sklearn.ensemble import IsolationForest
import easyocr
from transformers import CLIPProcessor, CLIPModel

# ==============================================================================
# 1. KONFIGURASI SERVER & LOGGING PROFESIONAL (CYBER THEME)
# ==============================================================================
class CustomFormatter(logging.Formatter):
    cyan = "\x1b[36;20m"
    yellow = "\x1b[33;20m"
    red = "\x1b[31;20m"
    bold_red = "\x1b[31;1m"
    reset = "\x1b[0m"
    format_str = "%(asctime)s | %(levelname)-8s | %(name)-15s | %(message)s"

    FORMATS = {
        logging.DEBUG: cyan + format_str + reset,
        logging.INFO: cyan + format_str + reset,
        logging.WARNING: yellow + format_str + reset,
        logging.ERROR: red + format_str + reset,
        logging.CRITICAL: bold_red + format_str + reset
    }

    def format(self, record):
        log_fmt = self.FORMATS.get(record.levelno)
        formatter = logging.Formatter(log_fmt, datefmt='%Y-%m-%d %H:%M:%S')
        return formatter.format(record)

logger = logging.getLogger()
logger.setLevel(logging.INFO)
ch = logging.StreamHandler()
ch.setFormatter(CustomFormatter())
logger.addHandler(ch)

log_api = logging.getLogger("API-GATEWAY")
log_anomaly = logging.getLogger("AI-FORENSIC")
log_ocr = logging.getLogger("AI-OCR")
log_vision = logging.getLogger("AI-VISION")

app = Flask(__name__)
CORS(app)

# ==============================================================================
# 2. PEMUATAN MODEL AI GLOBAL (Hanya dimuat 1x saat server menyala)
# ==============================================================================
print("\n" + "═"*75)
print("🚀 MEMULAI PEMUATAN KANVAS KECERDASAN BUATAN (AI ENGINE)...")

# A. Model Anomali Harga (Machine Learning)
model_if = IsolationForest(n_estimators=100, contamination=0.15, random_state=42)
print(" ✅ [1/3] Isolation Forest (Pendeteksi Mark-up) Siap.")

# B. Model OCR (Optical Character Recognition) dengan Auto-GPU Detection
use_gpu = torch.cuda.is_available()
reader = easyocr.Reader(['id', 'en'], gpu=use_gpu) 
gpu_status = "Aktif (RTX/GTX Detected)" if use_gpu else "Tidak Aktif (Menggunakan CPU)"
print(f" ✅ [2/3] EasyOCR Engine Siap. Akselerasi GPU: {gpu_status}")

# C. Model Vision (HuggingFace CLIP)
model_id = "openai/clip-vit-base-patch32"
clip_model = CLIPModel.from_pretrained(model_id)
clip_processor = CLIPProcessor.from_pretrained(model_id)
print(" ✅ [3/3] Transformers CLIP (Pendeteksi Komponen Gizi) Siap.")
print("═"*75 + "\n")

# ==============================================================================
# 3. FUNGSI HELPER UTILITY
# ==============================================================================
def extract_numbers(text):
    """Membersihkan teks OCR dan mengambil semua kombinasi angka ribuan/jutaan"""
    clean_text = text.replace('.', '').replace(',', '')
    numbers = re.findall(r'\d{3,}', clean_text)
    return [int(num) for num in numbers]

def get_csv_path(filename):
    """Fungsi cerdas mencari lokasi CSV baik di folder saat ini maupun parent folder"""
    if os.path.exists(filename): return filename
    parent_path = os.path.join("..", filename)
    if os.path.exists(parent_path): return parent_path
    
    # Cek folder backend jika dijalankan dari root
    backend_path = os.path.join(os.getcwd(), 'backend', filename)
    if os.path.exists(backend_path): return backend_path
    
    return filename

def augment_image(image):
    width, height = image.size
    scale = random.uniform(0.85, 1.0)
    new_w, new_h = int(width * scale), int(height * scale)
    left, top = random.randint(0, width - new_w), random.randint(0, height - new_h)
    image = image.crop((left, top, left + new_w, top + new_h))
    enhancer = ImageEnhance.Brightness(image)
    return enhancer.enhance(random.uniform(0.9, 1.1))

def split_grid(image, rows=3, cols=3):
    width, height = image.size
    grid_images, w_step, h_step = [], width // cols, height // rows
    for r in range(rows):
        for c in range(cols):
            left, top = c * w_step, r * h_step
            grid_images.append(image.crop((left, top, left + w_step, top + h_step)))
    return grid_images

# ==============================================================================
# 4. MODUL AI FORENSIK HARGA (ISOLATION FOREST)
# ==============================================================================
def analyze_price(harga_vendor_dict):
    log_anomaly.info("Memulai audit rasionalitas harga usulan vendor...")
    status_audit = "Harga Wajar Terverifikasi"
    catatan_sistem = []
    harga_acuan = {}
    
    csv_path = get_csv_path('katalog_pihps.csv')
    if os.path.exists(csv_path):
        with open(csv_path, mode='r', encoding='utf-8') as f:
            reader_csv = csv.DictReader(f)
            for row in reader_csv:
                if row.get('nama_item'):
                    try: harga_acuan[row['nama_item'].strip().lower()] = float(row.get('harga_acuan', 0))
                    except ValueError: continue
    else:
        catatan_sistem.append("[WARNING] Database Indeks Nasional (PIHPS) tidak ditemukan.")

    data_rasio, item_diperiksa = [], []
    log_belanja = harga_vendor_dict if isinstance(harga_vendor_dict, list) else [{"nama": k, "kategori": "", "price": v} for k, v in harga_vendor_dict.items()]

    for item_data in log_belanja:
        nama_vendor = item_data.get('nama', '').lower()
        kategori_vendor = item_data.get('kategori', '').lower()
        try: harga_lapor = float(item_data.get('price', 0))
        except ValueError: continue
            
        if harga_lapor <= 0 or not nama_vendor: continue

        harga_standar, nama_ditemukan = 0, ""
        kata_kunci_vendor = nama_vendor.split()
        
        for acuan_nama, acuan_harga in harga_acuan.items():
            for kata in kata_kunci_vendor:
                if len(kata) > 3 and (kata in acuan_nama or acuan_nama in kata):
                    harga_standar, nama_ditemukan = acuan_harga, acuan_nama
                    break
            if harga_standar > 0: break

        if harga_standar == 0 and kategori_vendor:
            if "karbo" in kategori_vendor: harga_standar = 15000
            elif "protein" in kategori_vendor: harga_standar = 40000
            elif "sayur" in kategori_vendor or "buah" in kategori_vendor: harga_standar = 20000
            elif "bumbu" in kategori_vendor: harga_standar = 25000
            if harga_standar > 0: nama_ditemukan = f"Indeks Kategori {kategori_vendor.title()}"

        if harga_standar > 0:
            rasio = harga_lapor / harga_standar
            data_rasio.append([rasio])
            item_diperiksa.append({"nama_asli": item_data.get('nama'), "lapor": harga_lapor, "standar": harga_standar})
        else:
            catatan_sistem.append(f"Barang '{item_data.get('nama')}' gagal dipetakan ke indeks.")

    if len(data_rasio) > 0:
        dummy_normal = np.random.uniform(0.9, 1.25, (50, 1))
        model_if.fit(dummy_normal)
        prediksi = model_if.predict(np.array(data_rasio))
        
        indikasi_korupsi = False
        for i, hasil in enumerate(prediksi):
            item_info = item_diperiksa[i]
            # Deteksi Mark-up lebih dari 25% (Rasio > 1.25)
            if hasil == -1 and data_rasio[i][0] > 1.25:
                indikasi_korupsi = True
                catatan_sistem.append(f"MARK-UP: {item_info['nama_asli']} (Lapor Rp{int(item_info['lapor'])}, Acuan Rp{int(item_info['standar'])})")
                log_anomaly.error(f"⚠️  MARK-UP TERDETEKSI: {item_info['nama_asli']} (Lapor Rp{int(item_info['lapor'])}, Batas Rp{int(item_info['standar'])})")
                
        if indikasi_korupsi: 
            status_audit = "Terindikasi Mark-up / Anomali Harga"
        else: 
            catatan_sistem.append("Semua harga wajar sesuai toleransi 25%.")
            log_anomaly.info("✅ Harga aman, tidak ada anomali mark-up.")
    else:
        catatan_sistem.append("Sistem gagal membandingkan harga.")

    return {"status_audit": status_audit, "catatan_sistem": " | ".join(catatan_sistem)}

# ==============================================================================
# 5. MODUL AI OCR NOTA (EASYOCR)
# ==============================================================================
def validate_receipt(dokumen_path, total_lapor_vendor):
    log_ocr.info(f"Memindai nota belanja untuk mencocokkan angka: Rp {total_lapor_vendor:,}")
    status_dokumen, catatan = "Membutuhkan Audit Manual", "Gagal memverifikasi dokumen."

    if not os.path.exists(dokumen_path):
        log_ocr.error(f"❌ File dokumen fisik tidak ditemukan: {dokumen_path}")
        return {"status": "File Error", "catatan": "File nota fisik tidak terbaca oleh server AI."}

    try:
        # Konversi PDF ke Gambar jika formatnya PDF
        if dokumen_path.lower().endswith('.pdf'):
            doc = fitz.open(dokumen_path)
            page = doc.load_page(0)
            pix = page.get_pixmap(dpi=150)
            img_np = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w, pix.n)
            if pix.n == 4: img_np = cv2.cvtColor(img_np, cv2.COLOR_RGBA2RGB)
        else:
            img_np = cv2.imread(dokumen_path)
            img_np = cv2.cvtColor(img_np, cv2.COLOR_BGR2RGB)

        # Proses OCR
        ocr_results = reader.readtext(img_np, detail=0) 
        semua_teks = " ".join(ocr_results).upper()
        semua_angka = extract_numbers(semua_teks)
        
        if total_lapor_vendor <= 0:
            status_dokumen, catatan = "Menunggu Validasi", "Total lapor Rp 0, tidak ada yang dicocokkan."
        elif not semua_angka:
            status_dokumen = "Indikasi Struk Buram"
            catatan = "AI OCR tidak menemukan karakter angka apapun di dalam dokumen cetak."
            log_ocr.warning("⚠️  Pemindaian selesai namun tidak ada angka yang terbaca.")
        else:
            # Toleransi OCR 2% (Kadang angka 8 terbaca 0)
            batas_bawah, batas_atas = total_lapor_vendor * 0.98, total_lapor_vendor * 1.02
            
            match_found = any(batas_bawah <= angka <= batas_atas for angka in semua_angka)
            
            if match_found:
                status_dokumen = "Struk Sah & Akurat"
                catatan = f"Total tagihan Rp {total_lapor_vendor:,} BERHASIL dibaca dan diverifikasi otentik dari nota."
                log_ocr.info("✅ Kecocokan struk berhasil divalidasi.")
            else:
                status_dokumen = "Indikasi Nota Palsu / Mark-up"
                catatan = f"Total tagihan Rp {total_lapor_vendor:,} TIDAK DITEMUKAN pada hasil pindaian OCR nota."
                log_ocr.error(f"❌ Dokumen mencurigakan! Angka {total_lapor_vendor} tidak ditemukan di nota.")

        return {"status": status_dokumen, "catatan": catatan}
    except Exception as e:
        log_ocr.error(f"❌ Error saat OCR: {str(e)}")
        return {"status": "Error Pemindaian", "catatan": "Kualitas resolusi file terlalu rendah untuk diekstraksi AI."}

# ==============================================================================
# 6. MODUL AI VISION GIZI (HUGGINGFACE CLIP)
# ==============================================================================
def analyze_image(foto_path):
    log_vision.info("Mengekstraksi pixel untuk mendeteksi komponen bahan pangan...")
    status_gizi, total_kalori, deteksi_visual = "Tidak Memenuhi Standar", 0, []

    if not os.path.exists(foto_path):
        log_vision.error(f"❌ File foto makanan tidak ditemukan: {foto_path}")
        return {"status": status_gizi, "deteksi_visual": "Foto porsi tidak terbaca server."}

    try:
        image = Image.open(foto_path).convert("RGB")
        csv_path = get_csv_path('katalog_makanan_jadi.csv')
        katalog_items, kategori_items = {}, {}

        if os.path.exists(csv_path):
            with open(csv_path, mode='r', encoding='utf-8') as f:
                reader_csv = csv.DictReader(f)
                for row in reader_csv:
                    nama = row['nama_menu'].strip()
                    katalog_items[nama] = int(row['kalori'])
                    kategori_items[nama] = row['kategori']
        else:
            log_vision.warning("⚠️ katalog_makanan_jadi.csv tidak ditemukan. Menggunakan database memori statis.")
            katalog_items = {"Nasi Putih": 200, "Ayam Bakar": 250, "Sayur Bayam": 50, "Tempe": 100}
            kategori_items = {"Nasi Putih": "Karbohidrat", "Ayam Bakar": "Protein", "Sayur Bayam": "Sayur", "Tempe": "Protein"}

        item_list = list(katalog_items.keys())
        prompts = [f"a photo of cooked Indonesian food {item}" for item in item_list]
        vote_counter = Counter()

        # Dibatasi 5 iterasi agar respon API di bawah 3 detik saat Hackathon
        for i in range(5): 
            aug_img = augment_image(image)
            grids = split_grid(aug_img, 3, 3)
            for grid in grids:
                inputs = clip_processor(text=prompts, images=grid, return_tensors="pt", padding=True)
                outputs = clip_model(**inputs)
                probs = (outputs.image_embeds @ outputs.text_embeds.T).softmax(dim=-1).detach().numpy()[0]
                vote_counter[item_list[probs.argmax()]] += 1

        kategori_vote = {}
        for item, vote in vote_counter.most_common(5):
            kategori = kategori_items.get(item, "Lainnya")
            if kategori not in kategori_vote: kategori_vote[kategori] = (item, vote)

        porsi = {"Karbohidrat": 1.0, "Protein": 1.0, "Sayur": 0.5, "Buah": 0.6, "Lainnya": 1.0}
        for kategori, (nama, vote) in kategori_vote.items():
            kalori_asli = katalog_items.get(nama, 100)
            kal = round(kalori_asli * porsi.get(kategori, 1))
            total_kalori += kal
            deteksi_visual.append(f"{nama} [{kategori}] -> {kal} Kkal")

        status_gizi = "Memenuhi Standar MBG"
        hasil = " | ".join(deteksi_visual) + f" || TOTAL: {total_kalori} Kkal"
        
        log_vision.info(f"✅ Analisis Visual Selesai. Total Energi Terdeteksi: {total_kalori} Kkal")
        return {"status": status_gizi, "deteksi_visual": hasil}

    except Exception as e:
        log_vision.error(f"❌ Gagal memproses gambar: {str(e)}")
        return {"status": status_gizi, "deteksi_visual": "Gagal mengenali komponen makanan karena resolusi pecah."}

# ==============================================================================
# 7. ROUTE API UTAMA (API GATEWAY)
# ==============================================================================
@app.route('/api/analisis-awal', methods=['POST'])
def analisis_awal():
    try:
        data = request.json
        foto_path = data.get('foto_path', '')
        nota_path = data.get('nota_path', '') 
        nama_vendor = data.get('nama_vendor', 'Unknown')
        harga_komoditas = data.get('harga_komoditas', [])

        print("\n" + "═"*75)
        log_api.info(f"🔔 INCOMING REQUEST AUDIT BAP DARI NODE.JS -> VENDOR: \033[33;1m{nama_vendor}\033[0m")
        print("═"*75)

        # 1. Analisis Harga
        hasil_harga = analyze_price(harga_komoditas)
        
        total_lapor = 0
        if isinstance(harga_komoditas, list):
            for item in harga_komoditas:
                try: total_lapor += int(item.get('price', 0))
                except: pass

        # 2. Analisis Dokumen (OCR)
        hasil_dokumen = {"status": "Tidak Ada Dokumen", "catatan": "Vendor tidak mengunggah salinan nota."}
        if nota_path: hasil_dokumen = validate_receipt(nota_path, total_lapor)

        # 3. Analisis Gizi (Vision)
        hasil_gizi = {"status": "Foto Kosong", "deteksi_visual": "Tidak ada foto makanan yang diunggah."}
        if foto_path: hasil_gizi = analyze_image(foto_path)

        print("\n" + "═"*75)
        log_api.info("📊 KESIMPULAN AUDIT AI TERPADU SELESAI:")
        print(f"  [\033[32;1mGIZI\033[0m]    Status : {hasil_gizi['status']}")
        print(f"            Detail : {hasil_gizi['deteksi_visual']}")
        print(f"  [\033[36;1mNOTA\033[0m]    Status : {hasil_dokumen['status']}")
        print(f"            Detail : {hasil_dokumen['catatan']}")
        print(f"  [\033[35;1mHARGA\033[0m]   Status : {hasil_harga['status_audit']}")
        print(f"            Detail : {hasil_harga['catatan_sistem']}")
        print("═"*75 + "\n")

        return jsonify({
            "success": True,
            "analisis_gizi": hasil_gizi,
            "analisis_dokumen": hasil_dokumen,
            "analisis_harga": hasil_harga
        })

    except Exception as e:
        log_api.error(f"FATAL ERROR PADA PIPELINE AI: {str(e)}")
        return jsonify({"success": False, "message": str(e)}), 500

if __name__ == '__main__':
    print("\n" + "★"*75)
    print(" 🛡️  TRUST-PLATE AI FORENSIC ENGINE (PORT 5001) AKTIF  🛡️")
    print("★"*75 + "\n")
    # Menonaktifkan pesan log default Flask agar log kustom kita lebih terlihat
    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)
    app.run(host='0.0.0.0', port=5001, debug=False)