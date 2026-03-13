import os
import csv
import torch
import random
import logging
from collections import Counter
from PIL import Image, ImageEnhance
from transformers import CLIPProcessor, CLIPModel

# ==========================================
# LOGGING SETUP
# ==========================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s"
)

log = logging.getLogger("AI-VISION")

log.info("Memuat CLIP Model...")

model_id = "openai/clip-vit-base-patch32"
model = CLIPModel.from_pretrained(model_id)
processor = CLIPProcessor.from_pretrained(model_id)

log.info("Model CLIP siap digunakan")


# ==========================================
# AUGMENTASI GAMBAR
# ==========================================

def augment_image(image):

    width, height = image.size

    scale = random.uniform(0.85,1.0)

    new_w = int(width*scale)
    new_h = int(height*scale)

    left = random.randint(0,width-new_w)
    top = random.randint(0,height-new_h)

    image = image.crop((left,top,left+new_w,top+new_h))

    enhancer = ImageEnhance.Brightness(image)
    image = enhancer.enhance(random.uniform(0.9,1.1))

    return image


# ==========================================
# GRID SPLIT
# ==========================================

def split_grid(image,rows=3,cols=3):

    width,height = image.size

    grid_images = []

    w_step = width//cols
    h_step = height//rows

    for r in range(rows):
        for c in range(cols):

            left = c*w_step
            top = r*h_step
            right = left+w_step
            bottom = top+h_step

            crop = image.crop((left,top,right,bottom))

            grid_images.append(crop)

    return grid_images


# ==========================================
# ANALISIS GAMBAR
# ==========================================

def analyze_image(foto_path):

    log.info("===================================================")
    log.info("AUDIT AI VISION DIMULAI")
    log.info("File gambar: %s", foto_path)

    status_gizi = "Tidak Memenuhi Standar"
    total_kalori = 0
    deteksi_visual = []

    parent_dir = os.path.dirname(os.getcwd())
    clean_foto_path = foto_path.lstrip('\\/')
    real_image_path = os.path.join(parent_dir,'backend',clean_foto_path)
    csv_path = os.path.join(parent_dir,'backend','katalog_makanan_jadi.csv')

    if not os.path.exists(real_image_path):
        real_image_path = os.path.join(os.getcwd(),clean_foto_path)

    if not os.path.exists(real_image_path):

        log.error("File gambar tidak ditemukan")

        return {
            "status":status_gizi,
            "deteksi_visual":"File gambar tidak ditemukan"
        }

    try:

        image = Image.open(real_image_path).convert("RGB")

        log.info("Resolusi gambar: %s",image.size)

        # ==========================================
        # LOAD DATASET
        # ==========================================

        katalog_items = {}
        kategori_items = {}

        with open(csv_path,mode='r',encoding='utf-8') as f:

            reader = csv.DictReader(f)

            for row in reader:

                nama = row['nama_menu'].strip()
                kategori = row['kategori']
                kalori = int(row['kalori'])

                katalog_items[nama] = kalori
                kategori_items[nama] = kategori

        item_list = list(katalog_items.keys())

        log.info("Dataset makanan dimuat (%d item)",len(item_list))

        prompts = [
            f"a photo of cooked Indonesian food ingredient {item}"
            for item in item_list
        ]

        vote_counter = Counter()

        # ==========================================
        # ITERASI AUGMENTASI
        # ==========================================

        for i in range(20):

            log.info("Iterasi augmentasi %d/20",i+1)

            aug_img = augment_image(image)

            grids = split_grid(aug_img,3,3)

            for idx,grid in enumerate(grids):

                inputs = processor(
                    text=prompts,
                    images=grid,
                    return_tensors="pt",
                    padding=True
                )

                outputs = model(**inputs)

                image_embeds = outputs.image_embeds
                text_embeds = outputs.text_embeds

                image_embeds = image_embeds / image_embeds.norm(p=2,dim=-1,keepdim=True)
                text_embeds = text_embeds / text_embeds.norm(p=2,dim=-1,keepdim=True)

                logits = (image_embeds @ text_embeds.T) * model.logit_scale.exp()

                probs = logits.softmax(dim=-1).detach().numpy()[0]

                best_idx = probs.argmax()

                item = item_list[best_idx]

                vote_counter[item]+=1

        log.info("Voting selesai")

        # ==========================================
        # SORT VOTING
        # ==========================================

        hasil_vote = vote_counter.most_common(10)

        for item,vote in hasil_vote:

            log.info("Vote: %s -> %d",item,vote)

        kategori_vote = {}

        for item,vote in hasil_vote:

            kategori = kategori_items[item]

            if kategori not in kategori_vote:

                kategori_vote[kategori]=(item,vote)

        bahan_terdeteksi = []

        for kategori,(item,vote) in kategori_vote.items():

            bahan_terdeteksi.append((item,vote,kategori))

        # ==========================================
        # ESTIMASI KALORI
        # ==========================================

        porsi = {
            "Karbohidrat":1.0,
            "Protein":1.0,
            "Sayur":0.5,
            "Buah":0.6,
            "Bumbu":0.2,
            "Minuman":1.0
        }

        for nama,vote,kategori in bahan_terdeteksi:

            kalori_asli = katalog_items[nama]

            multiplier = porsi.get(kategori,1)

            kal = round(kalori_asli*multiplier)

            total_kalori+=kal

            deteksi_visual.append(
                f"{nama} [vote:{vote}] -> {kal} Kkal"
            )

        status_gizi = "Memenuhi Standar MBG"

        log.info("Estimasi kalori total: %d Kkal",total_kalori)
        log.info("Analisis selesai")

        hasil = " | ".join(deteksi_visual)
        hasil += f" || TOTAL: {total_kalori} Kkal"

        return {
            "status":status_gizi,
            "deteksi_visual":hasil
        }

    except Exception as e:

        log.error("Error sistem: %s",str(e))

        return {
            "status":status_gizi,
            "deteksi_visual":str(e)
        }