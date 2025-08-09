import Template from "./Template";
import { base64ToUint8, numberToEncoded } from "./utils";

/** Manages the template system.
 * This class handles all external requests for template modification, creation, and analysis.
 * It serves as the central coordinator between template instances and the user interface.
 * @since 0.55.8
 * @example
 * // JSON structure for a template
 * {
 *   "whoami": "BlueMarble",
 *   "scriptVersion": "1.13.0",
 *   "schemaVersion": "2.1.0",
 *   "templates": {
 *     "0 $Z": {
 *       "name": "My Template",
 *       "enabled": true,
 *       "tiles": {
 *         "1231,0047,183,593": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA",
 *         "1231,0048,183,000": "data:image/png;AAAFCAYAAACNbyblAAAAHElEQVQI12P4"
 *       }
 *     },
 *     "1 $Z": {
 *       "name": "My Template",
 *       "URL": "https://github.com/SwingTheVine/Wplace-BlueMarble/blob/main/dist/assets/Favicon.png",
 *       "URLType": "template",
 *       "enabled": false,
 *       "tiles": {
 *         "375,1846,276,188": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA",
 *         "376,1846,000,188": "data:image/png;AAAFCAYAAACNbyblAAAAHElEQVQI12P4"
 *       }
 *     }
 *   }
 * }
 */
export default class TemplateManager {

  /** The constructor for the {@link TemplateManager} class.
   * @since 0.55.8
   */
  constructor(name, version, overlay) {

    // Meta
    this.name = name; // Name of userscript
    this.version = version; // Version of userscript
    this.overlay = overlay; // The main instance of the Overlay class
    this.templatesVersion = '1.0.0'; // Version of JSON schema
    this.userID = null; // The ID of the current user
    this.encodingBase = '!#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~'; // Characters to use for encoding/decoding
    this.tileSize = 1000; // The number of pixels in a tile. Assumes the tile is square
    this.drawMult = 3; // The enlarged size for each pixel. E.g. when "3", a 1x1 pixel becomes a 1x1 pixel inside a 3x3 area. MUST BE ODD
    
    // Template
    this.canvasTemplate = null; // Our canvas
    this.canvasTemplateZoomed = null; // The template when zoomed out
    this.canvasTemplateID = 'bm-canvas'; // Our canvas ID
    this.canvasMainID = 'div#map canvas.maplibregl-canvas'; // The selector for the main canvas
    this.template = null; // The template image.
    this.templateState = ''; // The state of the template ('blob', 'proccessing', 'template', etc.)
    this.templatesArray = []; // All Template instnaces currently loaded (Template)
    this.templatesJSON = null; // All templates currently loaded (JSON)
    this.templatesShouldBeDrawn = false; // Should ALL templates be drawn to the canvas? Disabled by default until enabled
    this.activeColorFilter = new Set(); // 'r,g,b' keys to show in overlay (empty = show all)
    // Performance helpers
    this.debug = false; // Toggle verbose logging
    this.statusThrottleMs = 250;
    this._lastStatusAt = 0;
    // Reusable canvases
    this._analysisCanvas = null; // For base tile analysis at native resolution
    this._analysisCtx = null;
    this._drawCanvas = null; // For composing returned tile blobs
    this._drawCtx = null;
    // Aggregate index of all base tiles that have any template content
    this.allTemplateTilesSet = new Set(); // Set of "TTTT,TTTT"
    // Analysis mode: legacy (3x center sampling) to match historical counts
    this.useLegacyCount = true;
  }

  /** Retrieves the pixel art canvas.
   * If the canvas has been updated/replaced, it retrieves the new one.
   * @param {string} selector - The CSS selector to use to find the canvas.
   * @returns {HTMLCanvasElement|null} The canvas as an HTML Canvas Element, or null if the canvas does not exist
   * @since 0.58.3
   * @deprecated Not in use since 0.63.25
   */
  /* @__PURE__ */getCanvas() {

    // If the stored canvas is "fresh", return the stored canvas
    if (document.body.contains(this.canvasTemplate)) {return this.canvasTemplate;}
    // Else, the stored canvas is "stale", get the canvas again

    // Attempt to find and destroy the "stale" canvas
    document.getElementById(this.canvasTemplateID)?.remove(); 

    const canvasMain = document.querySelector(this.canvasMainID);

    const canvasTemplateNew = document.createElement('canvas');
    canvasTemplateNew.id = this.canvasTemplateID;
    canvasTemplateNew.className = 'maplibregl-canvas';
    canvasTemplateNew.style.position = 'absolute';
    canvasTemplateNew.style.top = '0';
    canvasTemplateNew.style.left = '0';
    canvasTemplateNew.style.height = `${canvasMain?.clientHeight * (window.devicePixelRatio || 1)}px`;
    canvasTemplateNew.style.width = `${canvasMain?.clientWidth * (window.devicePixelRatio || 1)}px`;
    canvasTemplateNew.height = canvasMain?.clientHeight * (window.devicePixelRatio || 1);
    canvasTemplateNew.width = canvasMain?.clientWidth * (window.devicePixelRatio || 1);
    canvasTemplateNew.style.zIndex = '8999';
    canvasTemplateNew.style.pointerEvents = 'none';
    canvasMain?.parentElement?.appendChild(canvasTemplateNew); // Append the newCanvas as a child of the parent of the main canvas
    this.canvasTemplate = canvasTemplateNew; // Store the new canvas

    window.addEventListener('move', this.onMove);
    window.addEventListener('zoom', this.onZoom);
    window.addEventListener('resize', this.onResize);

    return this.canvasTemplate; // Return the new canvas
  }

  /** Creates the JSON object to store templates in
   * @returns {{ whoami: string, scriptVersion: string, schemaVersion: string, templates: Object }} The JSON object
   * @since 0.65.4
   */
  async createJSON() {
    return {
      "whoami": this.name.replace(' ', ''), // Name of userscript without spaces
      "scriptVersion": this.version, // Version of userscript
      "schemaVersion": this.templatesVersion, // Version of JSON schema
      "templates": {} // The templates
    };
  }

  /** Creates the template from the inputed file blob
   * @param {File} blob - The file blob to create a template from
   * @param {string} name - The display name of the template
   * @param {Array<number, number, number, number>} coords - The coordinates of the top left corner of the template
   * @since 0.65.77
   */
  async createTemplate(blob, name, coords) {

    // Creates the JSON object if it does not already exist
    if (!this.templatesJSON) {this.templatesJSON = await this.createJSON(); console.log(`Creating JSON...`);}

    this.overlay.handleDisplayStatus(`Creating template at ${coords.join(', ')}...`);

    // Creates a new template instance
    const template = new Template({
      displayName: name,
      sortID: 0, // Object.keys(this.templatesJSON.templates).length || 0, // Uncomment this to enable multiple templates (1/2)
      authorID: numberToEncoded(this.userID || 0, this.encodingBase),
      file: blob,
      coords: coords
    });
    //template.chunked = await template.createTemplateTiles(this.tileSize); // Chunks the tiles
    const { templateTiles, templateTilesBuffers } = await template.createTemplateTiles(this.tileSize); // Chunks the tiles
    template.chunked = templateTiles; // Stores the chunked tile bitmaps
    // Build fast indexes
    template.buildTileIndex();
    await template.buildCenterPixelIndex(this.drawMult);

    // Appends a child into the templates object
    // The child's name is the number of templates already in the list (sort order) plus the encoded player ID
    this.templatesJSON.templates[`${template.sortID} ${template.authorID}`] = {
      "name": template.displayName, // Display name of template
      "coords": coords.join(', '), // The coords of the template
      "enabled": true,
      "tiles": templateTilesBuffers // Stores the chunked tile buffers
    };

    this.templatesArray = []; // Remove this to enable multiple templates (2/2)
    this.templatesArray.push(template); // Pushes the Template object instance to the Template Array
    // Build color toggles UI for this template (populate inside accordion)
    if (template.activeColors == null) {
      template.activeColors = null; // show all by default
    }
    this.overlay.buildColorToggles(template, () => {
      this.overlay.handleDisplayStatus('Updated color filter.');
    });

    // ==================== PIXEL COUNT DISPLAY SYSTEM ====================
    // Display pixel count statistics with internationalized number formatting
    // This provides immediate feedback to users about template complexity and size
    // Reset placed counter and show initial progress 0/total
    template.resetPlacedPixels?.();
    const pixelCountFormatted = new Intl.NumberFormat().format(template.pixelCount);
    this.overlay.handleDisplayStatus(`Template created at ${coords.join(', ')}! Pixels done: 0/${pixelCountFormatted}\nWrong pixels: 0`);

    console.log(Object.keys(this.templatesJSON.templates).length);
    console.log(this.templatesJSON);
    console.log(this.templatesArray);
    console.log(JSON.stringify(this.templatesJSON));

    await this.#storeTemplates();
  }

  /** Generates a {@link Template} class instance from the JSON object template
   */
  #loadTemplate() {

  }

  /** Stores the JSON object of the loaded templates into TamperMonkey (GreaseMonkey) storage.
   * @since 0.72.7
   */
  async #storeTemplates() {
    GM.setValue('bmTemplates', JSON.stringify(this.templatesJSON));
  }

  /** Deletes a template from the JSON object.
   * Also delete's the corrosponding {@link Template} class instance
   */
  deleteTemplate() {

  }

  /** Disables the template from view
   */
  async disableTemplate() {

    // Creates the JSON object if it does not already exist
    if (!this.templatesJSON) {this.templatesJSON = await this.createJSON(); console.log(`Creating JSON...`);}


  }

  /** Draws all templates on the specified tile.
   * This method handles the rendering of template overlays on individual tiles.
   * @param {File} tileBlob - The pixels that are placed on a tile
   * @param {[number, number]} tileCoords - The tile coordinates [x, y]
   * @since 0.65.77
   */
  async drawTemplateOnTile(tileBlob, tileCoords) {

    // Returns early if no templates should be drawn
    if (!this.templatesShouldBeDrawn) {return tileBlob;}

    const drawSize = this.tileSize * this.drawMult; // Calculate draw multiplier for scaling

    // Format tile coordinates with proper padding for consistent lookup
    tileCoords = tileCoords[0].toString().padStart(4, '0') + ',' + tileCoords[1].toString().padStart(4, '0');

    if (this.debug) { console.log(`Searching for templates in tile: "${tileCoords}"`); }

    const templateArray = this.templatesArray; // Stores a copy for sorting
    if (this.debug) { console.log(templateArray); }

    // Sorts the array of Template class instances. 0 = first = lowest draw priority
    templateArray.sort((a, b) => {return a.sortID - b.sortID;});

    if (this.debug) { console.log(templateArray); }

    // Retrieves the relavent template tile blobs
    const templatesToDraw = templateArray
      .map(template => {
        const keys = template.tileIndex?.get(tileCoords) || [];
        if (keys.length === 0) { return null; }
        const firstKey = keys[0];
        const coords = firstKey.split(',');
          return {
          bitmap: template.chunked[firstKey],
            tileCoords: [coords[0], coords[1]],
            pixelCoords: [coords[2], coords[3]]
        };
      })
    .filter(Boolean);

    if (this.debug) { console.log(templatesToDraw); }

    const templateCount = templatesToDraw?.length || 0; // Number of templates to draw on this tile
    if (this.debug) { console.log(`templateCount = ${templateCount}`); }

    if (templateCount > 0) {
      const baseBitmap = await createImageBitmap(tileBlob);
      if (this.useLegacyCount) {
        // Legacy counting: render base at 3x and sample centers exactly as before
        const drawSizeLegacy = this.tileSize * this.drawMult;
        if (!this._analysisCanvas) {
          this._analysisCanvas = new OffscreenCanvas(drawSizeLegacy, drawSizeLegacy);
          this._analysisCtx = this._analysisCanvas.getContext('2d', { willReadFrequently: true });
          this._analysisCtx.imageSmoothingEnabled = false;
        }
        this._analysisCanvas.width = drawSizeLegacy;
        this._analysisCanvas.height = drawSizeLegacy;
        this._analysisCtx.clearRect(0, 0, drawSizeLegacy, drawSizeLegacy);
        this._analysisCtx.drawImage(baseBitmap, 0, 0, drawSizeLegacy, drawSizeLegacy);
        const baseImage = this._analysisCtx.getImageData(0, 0, drawSizeLegacy, drawSizeLegacy);

        const [tileXStr, tileYStr] = tileCoords.split(',');
        const tileXAbs = parseInt(tileXStr, 10);
        const tileYAbs = parseInt(tileYStr, 10);

        for (const template of templateArray) {
          const matchingTiles = template.tileIndex?.get(tileCoords) || [];
          if (matchingTiles.length === 0) { continue; }
          for (const tileKey of matchingTiles) {
            const coords = tileKey.split(',');
            const pixelOffsetX = Number(coords[2]);
            const pixelOffsetY = Number(coords[3]);
            const bmp = template.chunked[tileKey];
            const bmpWidth = bmp.width;
            const bmpHeight = bmp.height;
            const chunkWidthPx = Math.floor(bmpWidth / this.drawMult);
            const chunkHeightPx = Math.floor(bmpHeight / this.drawMult);
            // Read template colors by drawing the bitmap
            const tplCanvas = new OffscreenCanvas(bmpWidth, bmpHeight);
            const tplCtx = tplCanvas.getContext('2d', { willReadFrequently: true });
            tplCtx.imageSmoothingEnabled = false;
            tplCtx.clearRect(0, 0, bmpWidth, bmpHeight);
            tplCtx.drawImage(bmp, 0, 0);
            const tplImage = tplCtx.getImageData(0, 0, bmpWidth, bmpHeight);

            for (let y = 0; y < chunkHeightPx; y++) {
              for (let x = 0; x < chunkWidthPx; x++) {
                const centerX = (pixelOffsetX + x) * this.drawMult + 1;
                const centerY = (pixelOffsetY + y) * this.drawMult + 1;
                const tplCenterX = x * this.drawMult + 1;
                const tplCenterY = y * this.drawMult + 1;
                const tplIdx = (tplCenterY * bmpWidth + tplCenterX) * 4;
                const tplA = tplImage.data[tplIdx + 3];
                if (tplA === 0) { continue; }
                const baseIdx = (centerY * drawSizeLegacy + centerX) * 4;
                const br = baseImage.data[baseIdx + 0];
                const bg = baseImage.data[baseIdx + 1];
                const bb = baseImage.data[baseIdx + 2];
                const ba = baseImage.data[baseIdx + 3];
                const tr = tplImage.data[tplIdx + 0];
                const tg = tplImage.data[tplIdx + 1];
                const tb = tplImage.data[tplIdx + 2];
                const globalX = tileXAbs * this.tileSize + (pixelOffsetX + x);
                const globalY = tileYAbs * this.tileSize + (pixelOffsetY + y);
                const key = `${globalX},${globalY}`;
                if (ba === 0) {
                  if (template.placedPixelKeys.has(key)) { template.placedPixelKeys.delete(key); }
                  if (template.wrongPixelKeys.has(key)) { template.wrongPixelKeys.delete(key); }
                  continue;
                }
                if (br === tr && bg === tg && bb === tb) {
                  if (!template.placedPixelKeys.has(key)) { template.placedPixelKeys.add(key); }
                  if (template.wrongPixelKeys.has(key)) { template.wrongPixelKeys.delete(key); }
                } else {
                  if (!template.wrongPixelKeys.has(key)) { template.wrongPixelKeys.add(key); }
                  if (template.placedPixelKeys.has(key)) { template.placedPixelKeys.delete(key); }
                }
              }
            }
          }
        }
      } else {
        // Optimized counting path at native resolution
        if (!this._analysisCanvas) {
          this._analysisCanvas = new OffscreenCanvas(this.tileSize, this.tileSize);
          this._analysisCtx = this._analysisCanvas.getContext('2d', { willReadFrequently: true });
          this._analysisCtx.imageSmoothingEnabled = false;
        }
        this._analysisCanvas.width = this.tileSize;
        this._analysisCanvas.height = this.tileSize;
        this._analysisCtx.clearRect(0, 0, this.tileSize, this.tileSize);
        this._analysisCtx.drawImage(baseBitmap, 0, 0, this.tileSize, this.tileSize);
        const baseImage = this._analysisCtx.getImageData(0, 0, this.tileSize, this.tileSize);
        const basePacked = new Uint32Array(this.tileSize * this.tileSize);
        {
          const d = baseImage.data;
          let di = 0;
          for (let i = 0; i < basePacked.length; i++) {
            const r = d[di];
            const g = d[di + 1];
            const b = d[di + 2];
            const a = d[di + 3];
            basePacked[i] = a === 0 ? 0 : ((r << 16) | (g << 8) | b);
            di += 4;
          }
        }
        const [tileXStr, tileYStr] = tileCoords.split(',');
        const tileXAbs = parseInt(tileXStr, 10);
        const tileYAbs = parseInt(tileYStr, 10);
        for (const template of templateArray) {
          const matchingTiles = template.tileIndex?.get(tileCoords) || [];
          if (matchingTiles.length === 0) { continue; }
          for (const tileKey of matchingTiles) {
            const coords = tileKey.split(',');
            const pixelOffsetX = Number(coords[2]);
            const pixelOffsetY = Number(coords[3]);
            const centerInfo = template.centerPixelIndex?.[tileKey];
            if (!centerInfo) { continue; }
            const { width: chunkWidthPx, height: chunkHeightPx, data: centerData } = centerInfo;
            for (let y = 0; y < chunkHeightPx; y++) {
              for (let x = 0; x < chunkWidthPx; x++) {
                const dstX = pixelOffsetX + x;
                const dstY = pixelOffsetY + y;
                if (dstX < 0 || dstY < 0 || dstX >= this.tileSize || dstY >= this.tileSize) { continue; }
                const baseVal = basePacked[dstY * this.tileSize + dstX];
                const tplVal = centerData[y * chunkWidthPx + x];
                if (tplVal === 0) { continue; }
                const globalX = tileXAbs * this.tileSize + dstX;
                const globalY = tileYAbs * this.tileSize + dstY;
                const key = `${globalX},${globalY}`;
                if (baseVal === 0) {
                  if (template.placedPixelKeys.has(key)) { template.placedPixelKeys.delete(key); }
                  if (template.wrongPixelKeys.has(key)) { template.wrongPixelKeys.delete(key); }
                  continue;
                }
                if (baseVal === tplVal) {
                  if (!template.placedPixelKeys.has(key)) { template.placedPixelKeys.add(key); }
                  if (template.wrongPixelKeys.has(key)) { template.wrongPixelKeys.delete(key); }
                } else {
                  if (!template.wrongPixelKeys.has(key)) { template.wrongPixelKeys.add(key); }
                  if (template.placedPixelKeys.has(key)) { template.placedPixelKeys.delete(key); }
                }
              }
            }
          }
        }
      }

      // Sum up totals across templates for UI
      const totalPlaced = templateArray.reduce((s, t) => s + (t.getPlacedPixelsCount ? t.getPlacedPixelsCount() : 0), 0);
      const totalWrong = templateArray.reduce((s, t) => s + (t.getWrongPixelsCount ? t.getWrongPixelsCount() : 0), 0);
      const totalPixels = templateArray.reduce((s, t) => s + (t.pixelCount || 0), 0);

      const placedFormatted = new Intl.NumberFormat().format(totalPlaced);
      const wrongFormatted = new Intl.NumberFormat().format(totalWrong);
      const totalFormatted = new Intl.NumberFormat().format(totalPixels);

      this.#throttledStatus(
        `Displaying ${templateCount} template${templateCount == 1 ? '' : 's'}.\nPixels done: ${placedFormatted}/${totalFormatted}\nWrong pixels: ${wrongFormatted}`
      );
    } else {
      // When no templates affect this tile, return original blob untouched for speed
      return tileBlob;
    }
    
    const tileBitmap = await createImageBitmap(tileBlob);

    if (!this._drawCanvas) {
      this._drawCanvas = new OffscreenCanvas(drawSize, drawSize);
      this._drawCtx = this._drawCanvas.getContext('2d');
    }
    // Ensure size
    this._drawCanvas.width = drawSize;
    this._drawCanvas.height = drawSize;
    const context = this._drawCtx;

    context.imageSmoothingEnabled = false; // Nearest neighbor

    // Tells the canvas to ignore anything outside of this area
    context.beginPath();
    context.rect(0, 0, drawSize, drawSize);
    context.clip();

    context.clearRect(0, 0, drawSize, drawSize); // Draws transparent background
    context.drawImage(tileBitmap, 0, 0, drawSize, drawSize);

      // For each template in this tile, draw them respecting color filter
      for (const tpl of this.templatesArray) {
        const keys = tpl.tileIndex?.get(tileCoords) || [];
        for (const tileKey of keys) {
          const bmp = tpl.chunked[tileKey];
          const px = Number(tileKey.split(',')[2]);
          const py = Number(tileKey.split(',')[3]);
          // Semantics:
          // - activeColors == null  => show all colors (no filter)
          // - activeColors.size == 0 => show none
          // - otherwise             => show only colors in the set
          if (tpl.activeColors == null) {
            context.drawImage(bmp, px * this.drawMult, py * this.drawMult);
          } else if (tpl.activeColors.size === 0) {
            continue;
          } else {
            // Draw filtered: mask out pixels not in active colors
            const bw = bmp.width, bh = bmp.height;
            const c = new OffscreenCanvas(bw, bh);
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(bmp, 0, 0);
            const img = ctx.getImageData(0, 0, bw, bh);
            for (let y = 1; y < bh; y += this.drawMult) {
              for (let x = 1; x < bw; x += this.drawMult) {
                const idx = (y * bw + x) * 4;
                const a = img.data[idx + 3];
                if (a === 0) { continue; }
                const r = img.data[idx + 0];
                const g = img.data[idx + 1];
                const b = img.data[idx + 2];
                const key = `${r},${g},${b}`;
                if (tpl.activeColors && !tpl.activeColors.has(key)) {
                  // Blank the 3x3 block around the center
                  for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                      const xx = x + dx;
                      const yy = y + dy;
                      if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) { continue; }
                      const ii = (yy * bw + xx) * 4;
                      img.data[ii + 3] = 0;
                    }
                  }
                }
              }
            }
            ctx.putImageData(img, 0, 0);
            context.drawImage(c, px * this.drawMult, py * this.drawMult);
          }
        }
      }

    return await this._drawCanvas.convertToBlob({ type: 'image/png' });
  }

  /** Imports the JSON object, and appends it to any JSON object already loaded
   * @param {string} json - The JSON string to parse
   */
  importJSON(json) {

    console.log(`Importing JSON...`);
    console.log(json);

    // If the passed in JSON is a Blue Marble template object...
    if (json?.whoami == 'BlueMarble') {
      this.#parseBlueMarble(json); // ...parse the template object as Blue Marble
    }
  }

  /** Parses the Blue Marble JSON object
   * @param {string} json - The JSON string to parse
   * @since 0.72.13
   */
  async #parseBlueMarble(json) {

    console.log(`Parsing BlueMarble...`);

    const templates = json.templates;

    console.log(`BlueMarble length: ${Object.keys(templates).length}`);

    if (Object.keys(templates).length > 0) {

      for (const template in templates) {

        const templateKey = template;
        const templateValue = templates[template];
        console.log(templateKey);

        if (templates.hasOwnProperty(template)) {

          const templateKeyArray = templateKey.split(' '); // E.g., "0 $Z" -> ["0", "$Z"]
          const sortID = Number(templateKeyArray?.[0]); // Sort ID of the template
          const authorID = templateKeyArray?.[1] || '0'; // User ID of the person who exported the template
          const displayName = templateValue.name || `Template ${sortID || ''}`; // Display name of the template
          //const coords = templateValue?.coords?.split(',').map(Number); // "1,2,3,4" -> [1, 2, 3, 4]
          const tilesbase64 = templateValue.tiles;
          const templateTiles = {}; // Stores the template bitmap tiles for each tile.

          for (const tile in tilesbase64) {
            console.log(tile);
            if (tilesbase64.hasOwnProperty(tile)) {
              const encodedTemplateBase64 = tilesbase64[tile];
              const templateUint8Array = base64ToUint8(encodedTemplateBase64); // Base 64 -> Uint8Array

              const templateBlob = new Blob([templateUint8Array], { type: "image/png" }); // Uint8Array -> Blob
              const templateBitmap = await createImageBitmap(templateBlob) // Blob -> Bitmap
              templateTiles[tile] = templateBitmap;
            }
          }

          // Creates a new Template class instance
          const template = new Template({
            displayName: displayName,
            sortID: sortID || this.templatesArray?.length || 0,
            authorID: authorID || '',
            //coords: coords
          });
          template.chunked = templateTiles;
          // Build fast indexes for imported templates
          template.buildTileIndex();
          await template.buildCenterPixelIndex(this.drawMult);
          for (const tileXY of template.tileIndex.keys()) {
            this.allTemplateTilesSet.add(tileXY);
          }
          // Compute total pixel count from chunked bitmaps if not provided
          try {
            let computedTotalPixels = 0;
            for (const key in templateTiles) {
              if (!Object.prototype.hasOwnProperty.call(templateTiles, key)) { continue; }
              const bmp = templateTiles[key];
              const chunkWidthPx = Math.floor(bmp.width / this.drawMult);
              const chunkHeightPx = Math.floor(bmp.height / this.drawMult);
              computedTotalPixels += chunkWidthPx * chunkHeightPx;
            }
            template.pixelCount = computedTotalPixels;
          } catch (e) {
            console.warn('Failed to compute template pixel count from chunked tiles:', e);
          }
          this.templatesArray.push(template);
          console.log(this.templatesArray);
          console.log(`^^^ This ^^^`);
        }
      }
    }
  }

  /** Parses the OSU! Place JSON object
   */
  #parseOSU() {

  }

  /** Sets the `templatesShouldBeDrawn` boolean to a value.
   * @param {boolean} value - The value to set the boolean to
   * @since 0.73.7
   */
  setTemplatesShouldBeDrawn(value) {
    this.templatesShouldBeDrawn = value;
  }

  /** Throttles frequent status updates to reduce DOM churn */
  #throttledStatus(text) {
    const now = performance.now();
    if (now - this._lastStatusAt >= this.statusThrottleMs) {
      this._lastStatusAt = now;
      this.overlay.handleDisplayStatus(text);
    }
  }
}
