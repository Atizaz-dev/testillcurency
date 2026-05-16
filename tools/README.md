# Optional tools (Python)

## rembg — garment cutout when color contrast is low

The web app’s built-in mask uses **edges + flood fill**. If the product and background are the **same hue** (maroon on burgundy wall, red on red), use **rembg**: a free, local neural segmenter.

1. Install Python 3.10+ and run:

   ```bash
   pip install -r tools/requirements-tools.txt
   ```

2. Create a transparent PNG:

   ```bash
   python tools/segment_garment.py your-photo.jpg cutout.png
   ```

3. In **Garment mockup studio**: upload `your-photo.jpg` as the garment photo, then open **“Same-color garment vs background”** and load `cutout.png`.

**Alternatives you can use offline** (then load any PNG with transparency the same way): [remove.bg](https://www.remove.bg) (free tier), GIMP foreground select, Photoshop Select Subject, etc.

**OpenCV grabCut** (also free) needs a rough box or strokes around the subject; it is not wired into this repo, but `opencv-python` + tutorials work well if you prefer no ML download.
