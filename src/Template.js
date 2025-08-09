import { uint8ToBase64 } from "./utils";

/** An instance of a template.
 * Handles all mathematics, manipulation, and analysis regarding a single template.
 * @since 0.65.2
 */
export default class Template {

  /** The constructor for the {@link Template} class with enhanced pixel tracking.
   * @param {Object} [params={}] - Object containing all optional parameters
   * @param {string} [params.displayName='My template'] - The display name of the template
   * @param {number} [params.sortID=0] - The sort number of the template for rendering priority
   * @param {string} [params.authorID=''] - The user ID of the person who exported the template (prevents sort ID collisions)
   * @param {string} [params.url=''] - The URL to the source image
   * @param {File} [params.file=null] - The template file (pre-processed File or processed bitmap)
   * @param {[number, number, number, number]} [params.coords=null] - The coordinates of the top left corner as (tileX, tileY, pixelX, pixelY)
   * @param {Object} [params.chunked=null] - The affected chunks of the template, and their template for each chunk
   * @param {number} [params.tileSize=1000] - The size of a tile in pixels (assumes square tiles)
   * @param {number} [params.pixelCount=0] - Total number of pixels in the template (calculated automatically during processing)
   * @since 0.65.2
   */
  constructor({
    displayName = 'My template',
    sortID = 0,
    authorID = '',
    url = '',
    file = null,
    coords = null,
    chunked = null,
    tileSize = 1000,
  } = {}) {
    this.displayName = displayName;
    this.sortID = sortID;
    this.authorID = authorID;
    this.url = url;
    this.file = file;
    this.coords = coords;
    this.chunked = chunked;
    this.tileSize = tileSize;
    this.pixelCount = 0; // Total pixel count in template
    this.placedPixelKeys = new Set(); // Tracks unique placed pixels (global, scaled coords)
    this.wrongPixelKeys = new Set(); // Tracks unique wrong pixels (global, scaled coords)
    this.colorsUsed = new Map(); // 'r,g,b' -> count of pixels in template
    this.activeColors = new Set(); // Set of 'r,g,b' keys currently enabled for overlay display
    // Indexed lookups for performance
    this.centerPixelIndex = {}; // tileKey -> { width, height, data: Uint32Array (24-bit RGB; 0 = transparent) }
    this.tileIndex = new Map(); // "TTTT,TTTT" -> [tileKeys]
  }

  /** Clears the tracked placed pixels for this template. */
  resetPlacedPixels() {
    this.placedPixelKeys.clear();
  }

  /** Returns the number of placed pixels accounted for this template. */
  getPlacedPixelsCount() {
    return this.placedPixelKeys.size;
  }

  /** Clears the tracked wrong pixels for this template. */
  resetWrongPixels() {
    this.wrongPixelKeys.clear();
  }

  /** Returns the number of wrong pixels accounted for this template. */
  getWrongPixelsCount() {
    return this.wrongPixelKeys.size;
  }

  /** Creates chunks of the template for each tile.
   * 
   * @returns {Object} Collection of template bitmaps & buffers organized by tile coordinates
   * @since 0.65.4
   */
  async createTemplateTiles() {
    console.log('Template coordinates:', this.coords);

    const shreadSize = 3; // Scale image factor for pixel art enhancement (must be odd)
    const bitmap = await createImageBitmap(this.file); // Create efficient bitmap from uploaded file
    const imageWidth = bitmap.width;
    const imageHeight = bitmap.height;
    
    // Calculate total pixel count using standard width × height formula
    // TODO: Use non-transparent pixels instead of basic width times height
    const totalPixels = imageWidth * imageHeight;
    console.log(`Template pixel analysis - Dimensions: ${imageWidth}×${imageHeight} = ${totalPixels.toLocaleString()} pixels`);
    
    // Store pixel count in instance property for access by template manager and UI components
    this.pixelCount = totalPixels;

    const templateTiles = {}; // Holds the template tiles
    const templateTilesBuffers = {}; // Holds the buffers of the template tiles

    const canvas = new OffscreenCanvas(this.tileSize, this.tileSize);
    const context = canvas.getContext('2d', { willReadFrequently: true });

    // For every tile...
    for (let pixelY = this.coords[3]; pixelY < imageHeight + this.coords[3]; ) {

      // Draws the partial tile first, if any
      // This calculates the size based on which is smaller:
      // A. The top left corner of the current tile to the bottom right corner of the current tile
      // B. The top left corner of the current tile to the bottom right corner of the image
      const drawSizeY = Math.min(this.tileSize - (pixelY % this.tileSize), imageHeight - (pixelY - this.coords[3]));

      console.log(`Math.min(${this.tileSize} - (${pixelY} % ${this.tileSize}), ${imageHeight} - (${pixelY - this.coords[3]}))`);

      for (let pixelX = this.coords[2]; pixelX < imageWidth + this.coords[2];) {

        console.log(`Pixel X: ${pixelX}\nPixel Y: ${pixelY}`);

        // Draws the partial tile first, if any
        // This calculates the size based on which is smaller:
        // A. The top left corner of the current tile to the bottom right corner of the current tile
        // B. The top left corner of the current tile to the bottom right corner of the image
        const drawSizeX = Math.min(this.tileSize - (pixelX % this.tileSize), imageWidth - (pixelX - this.coords[2]));

        console.log(`Math.min(${this.tileSize} - (${pixelX} % ${this.tileSize}), ${imageWidth} - (${pixelX - this.coords[2]}))`);

        console.log(`Draw Size X: ${drawSizeX}\nDraw Size Y: ${drawSizeY}`);

        // Change the canvas size and wipe the canvas
        const canvasWidth = drawSizeX * shreadSize;// + (pixelX % this.tileSize) * shreadSize;
        const canvasHeight = drawSizeY * shreadSize;// + (pixelY % this.tileSize) * shreadSize;
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;

        console.log(`Draw X: ${drawSizeX}\nDraw Y: ${drawSizeY}\nCanvas Width: ${canvasWidth}\nCanvas Height: ${canvasHeight}`);

        context.imageSmoothingEnabled = false; // Nearest neighbor

        console.log(`Getting X ${pixelX}-${pixelX + drawSizeX}\nGetting Y ${pixelY}-${pixelY + drawSizeY}`);

        // Draws the template segment on this tile segment
        context.clearRect(0, 0, canvasWidth, canvasHeight); // Clear any previous drawing (only runs when canvas size does not change)
        context.drawImage(
          bitmap, // Bitmap image to draw
          pixelX - this.coords[2], // Coordinate X to draw from
          pixelY - this.coords[3], // Coordinate Y to draw from
          drawSizeX, // X width to draw from
          drawSizeY, // Y height to draw from
          0, // Coordinate X to draw at
          0, // Coordinate Y to draw at
          drawSizeX * shreadSize, // X width to draw at
          drawSizeY * shreadSize // Y height to draw at
        ); // Coordinates and size of draw area of source image, then canvas

        // const final = await canvas.convertToBlob({ type: 'image/png' });
        // const url = URL.createObjectURL(final); // Creates a blob URL
        // window.open(url, '_blank'); // Opens a new tab with blob
        // setTimeout(() => URL.revokeObjectURL(url), 60000); // Destroys the blob 1 minute later

        const imageData = context.getImageData(0, 0, canvasWidth, canvasHeight); // Data of the image on the canvas

        for (let y = 0; y < canvasHeight; y++) {
          for (let x = 0; x < canvasWidth; x++) {
            // For every pixel...
            const pixelIndex = (y * canvasWidth + x) * 4;
            const isCenter = (x % shreadSize === 1 && y % shreadSize === 1);
            if (isCenter) {
              const a = imageData.data[pixelIndex + 3];
              if (a !== 0) {
                const r = imageData.data[pixelIndex + 0];
                const g = imageData.data[pixelIndex + 1];
                const b = imageData.data[pixelIndex + 2];
                const key = `${r},${g},${b}`;
                this.colorsUsed.set(key, (this.colorsUsed.get(key) || 0) + 1);
              }
            } else {
              // Make non-center transparent
              imageData.data[pixelIndex + 3] = 0;
            }
          }
        }

        console.log(`Shreaded pixels for ${pixelX}, ${pixelY}`, imageData);

        context.putImageData(imageData, 0, 0);

        // Creates the "0000,0000,000,000" key name
        const templateTileName = `${(this.coords[0] + Math.floor(pixelX / 1000))
          .toString()
          .padStart(4, '0')},${(this.coords[1] + Math.floor(pixelY / 1000))
          .toString()
          .padStart(4, '0')},${(pixelX % 1000)
          .toString()
          .padStart(3, '0')},${(pixelY % 1000).toString().padStart(3, '0')}`;

        templateTiles[templateTileName] = await createImageBitmap(canvas); // Creates the bitmap
        
        const canvasBlob = await canvas.convertToBlob();
        const canvasBuffer = await canvasBlob.arrayBuffer();
        const canvasBufferBytes = Array.from(new Uint8Array(canvasBuffer));
        templateTilesBuffers[templateTileName] = uint8ToBase64(canvasBufferBytes); // Stores the buffer

        console.log(templateTiles);

        // ==================== BUILD INDEXES (CENTER PIXELS + TILE KEYS) ====================
        // Build center-pixel RGBA index for this chunk once
        const chunkWidthPx = Math.floor(canvasWidth / shreadSize);
        const chunkHeightPx = Math.floor(canvasHeight / shreadSize);
        const centerData = new Uint32Array(chunkWidthPx * chunkHeightPx);
        // Reuse existing imageData; sample only center positions
        for (let yy = 0; yy < chunkHeightPx; yy++) {
          for (let xx = 0; xx < chunkWidthPx; xx++) {
            const cx = xx * shreadSize + 1;
            const cy = yy * shreadSize + 1;
            const srcIdx = (cy * canvasWidth + cx) * 4;
            const a = imageData.data[srcIdx + 3];
            if (a === 0) {
              centerData[yy * chunkWidthPx + xx] = 0;
            } else {
              const r = imageData.data[srcIdx + 0];
              const g = imageData.data[srcIdx + 1];
              const b = imageData.data[srcIdx + 2];
              centerData[yy * chunkWidthPx + xx] = (r << 16) | (g << 8) | b;
            }
          }
        }
        this.centerPixelIndex[templateTileName] = {
          width: chunkWidthPx,
          height: chunkHeightPx,
          data: centerData
        };
        // Update tileIndex mapping for quick retrieval by base tile coords
        const tileXY = templateTileName.split(',').slice(0, 2).join(',');
        const list = this.tileIndex.get(tileXY) || [];
        list.push(templateTileName);
        this.tileIndex.set(tileXY, list);

        pixelX += drawSizeX;
      }

      pixelY += drawSizeY;
    }

    console.log('Template Tiles: ', templateTiles);
    console.log('Template Tiles Buffers: ', templateTilesBuffers);
    // Initialize activeColors to include all discovered colors
    for (const key of this.colorsUsed.keys()) {
      this.activeColors.add(key);
    }
    return { templateTiles, templateTilesBuffers };
  }

  /** Builds a fast index from existing chunked bitmaps mapping base tile -> chunk keys. */
  buildTileIndex() {
    this.tileIndex = new Map();
    if (!this.chunked) { return; }
    for (const key of Object.keys(this.chunked)) {
      const tileXY = key.split(',').slice(0, 2).join(',');
      if (!this.tileIndex.has(tileXY)) { this.tileIndex.set(tileXY, []); }
      this.tileIndex.get(tileXY).push(key);
    }
  }

  /** Builds center-pixel RGBA index for each chunk from the existing bitmaps. */
  async buildCenterPixelIndex(drawMult = 3) {
    this.centerPixelIndex = {};
    this.colorsUsed = new Map();
    if (!this.chunked) { return; }
    for (const key of Object.keys(this.chunked)) {
      const bmp = this.chunked[key];
      const bmpWidth = bmp.width;
      const bmpHeight = bmp.height;
      const chunkWidthPx = Math.floor(bmpWidth / drawMult);
      const chunkHeightPx = Math.floor(bmpHeight / drawMult);
      const canvas = new OffscreenCanvas(bmpWidth, bmpHeight);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, bmpWidth, bmpHeight);
      ctx.drawImage(bmp, 0, 0);
      const tplImage = ctx.getImageData(0, 0, bmpWidth, bmpHeight);
      const centerData = new Uint32Array(chunkWidthPx * chunkHeightPx);
      for (let y = 0; y < chunkHeightPx; y++) {
        for (let x = 0; x < chunkWidthPx; x++) {
          const cx = x * drawMult + 1;
          const cy = y * drawMult + 1;
          const srcIdx = (cy * bmpWidth + cx) * 4;
          const a = tplImage.data[srcIdx + 3];
          if (a === 0) {
            centerData[y * chunkWidthPx + x] = 0;
          } else {
            const r = tplImage.data[srcIdx + 0];
            const g = tplImage.data[srcIdx + 1];
            const b = tplImage.data[srcIdx + 2];
            centerData[y * chunkWidthPx + x] = (r << 16) | (g << 8) | b;
            const key = `${r},${g},${b}`;
            this.colorsUsed.set(key, (this.colorsUsed.get(key) || 0) + 1);
          }
        }
      }
      this.centerPixelIndex[key] = { width: chunkWidthPx, height: chunkHeightPx, data: centerData };
    }
    // Refresh activeColors to include all colors by default
    this.activeColors = new Set(this.colorsUsed.keys());
  }
}
