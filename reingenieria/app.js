(() => {
  "use strict";

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const app = { wasm: null, calculatorMode: 1, graphMode: 0, selectedCell: "A1" };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  function wasmBytes(ptr, length) {
    return new Uint8Array(app.wasm.memory.buffer, ptr >>> 0, length >>> 0).slice();
  }

  function wasmString(ptr, length) {
    return decoder.decode(wasmBytes(ptr, length));
  }

  function withInput(value, callback) {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    const pointer = app.wasm.wasm_alloc(bytes.length);
    new Uint8Array(app.wasm.memory.buffer, pointer, bytes.length).set(bytes);
    try {
      return callback(pointer, bytes.length);
    } finally {
      app.wasm.wasm_dealloc(pointer, bytes.length);
    }
  }

  function evaluate(source, angleMode = 0, x = 0, allowX = false) {
    return withInput(source, (ptr, length) => {
      const value = app.wasm.wasm_evaluate(ptr, length, angleMode, x, Number(allowX));
      const error = wasmString(app.wasm.wasm_error_ptr(), app.wasm.wasm_error_len());
      if (error) throw new Error(error);
      return value;
    });
  }

  function wasmOutput() {
    return wasmBytes(app.wasm.wasm_output_ptr(), app.wasm.wasm_output_len());
  }

  function download(name, data, mimeType) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function showScreen(name) {
    $$(".screen").forEach((screen) => {
      const active = screen.id === `screen-${name}`;
      screen.classList.toggle("active", active);
      screen.hidden = !active;
    });
    if (name === "graph") drawGraph();
    if (name === "sheet") renderSheet();
  }

  function initNavigation() {
    document.addEventListener("click", (event) => {
      const button = event.target.closest("[data-screen]");
      if (button) showScreen(button.dataset.screen);
    });
  }

  function initCalculator() {
    const expression = $("#calc-expression");
    const result = $("#calc-result");
    const message = $("#calc-message");
    const render = (calculate = false) => {
      result.classList.remove("error");
      if (!expression.value.trim()) {
        result.value = "0";
        message.textContent = "Lista";
        return;
      }
      try {
        const value = evaluate(expression.value, app.calculatorMode);
        result.value = Number(value.toPrecision(12)).toString();
        message.textContent = calculate ? "Resultado" : "Vista previa";
      } catch (error) {
        result.value = calculate ? error.message : "—";
        result.classList.toggle("error", calculate);
        message.textContent = calculate ? "Error" : "En curso";
      }
    };
    expression.addEventListener("input", () => render());
    $$(".segmented button[data-calc-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        app.calculatorMode = Number(button.dataset.calcMode);
        $$(".segmented button[data-calc-mode]").forEach((item) => item.classList.toggle("selected", item === button));
        $("#calc-mode-label").textContent = app.calculatorMode ? "Grados" : "Radianes";
        render();
      });
    });
    $("#calc-clear").addEventListener("click", () => {
      expression.value = "";
      render();
      expression.focus();
    });
    $("#calc-keypad").addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.insert) {
        const start = expression.selectionStart;
        const end = expression.selectionEnd;
        expression.setRangeText(button.dataset.insert, start, end, "end");
        expression.focus();
        render();
      } else if (button.dataset.action === "backspace") {
        const start = expression.selectionStart;
        const end = expression.selectionEnd;
        if (start !== end) expression.setRangeText("", start, end, "end");
        else if (start > 0) expression.setRangeText("", start - 1, start, "end");
        expression.focus();
        render();
      } else if (button.dataset.action === "sign") {
        const value = expression.value.trim();
        expression.value = value.startsWith("-(") && value.endsWith(")")
          ? value.slice(2, -1) : value ? `-(${value})` : "-";
        expression.focus();
        render();
      } else if (button.dataset.action === "equals") {
        render(true);
      }
    });
    expression.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        render(true);
      } else if (event.key === "Escape") {
        expression.value = "";
        render();
      }
    });
    render();
  }

  const graph = {
    canvas: $("#graph-canvas"),
    expression: $("#graph-expression"),
    range: { xMin: $("#x-min"), xMax: $("#x-max"), yMin: $("#y-min"), yMax: $("#y-max") },
    function: (x) => Math.sin(x),
    current: { xMin: -10, xMax: 10, yMin: -5, yMax: 5 },
    pointer: null
  };

  function niceStep(span) {
    const rough = span / 9;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const part = rough / magnitude;
    return (part <= 1 ? 1 : part <= 2 ? 2 : part <= 5 ? 5 : 10) * magnitude;
  }

  function tick(value, step) {
    const digits = Math.max(0, Math.min(7, -Math.floor(Math.log10(step)) + 1));
    const rounded = Number(value.toFixed(digits));
    return Object.is(rounded, -0) ? "0" : String(rounded);
  }

  function drawGraph() {
    const canvas = graph.canvas;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height || !app.wasm) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const { xMin, xMax, yMin, yMax } = graph.current;
    const width = rect.width;
    const height = rect.height;
    const px = (x) => (x - xMin) / (xMax - xMin) * width;
    const py = (y) => height - (y - yMin) / (yMax - yMin) * height;
    ctx.fillStyle = "#11121b";
    ctx.fillRect(0, 0, width, height);
    ctx.font = "10px ui-monospace, monospace";
    const sx = niceStep(xMax - xMin);
    const sy = niceStep(yMax - yMin);
    ctx.strokeStyle = "rgba(186,178,216,.12)";
    ctx.fillStyle = "#88859a";
    ctx.textBaseline = "top";
    ctx.textAlign = "center";
    for (let x = Math.ceil(xMin / sx) * sx; x <= xMax; x += sx) {
      ctx.beginPath(); ctx.moveTo(px(x), 0); ctx.lineTo(px(x), height); ctx.stroke();
      if (Math.abs(x) > sx / 1000) ctx.fillText(tick(x, sx), px(x), height - 18);
    }
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    for (let y = Math.ceil(yMin / sy) * sy; y <= yMax; y += sy) {
      ctx.beginPath(); ctx.moveTo(0, py(y)); ctx.lineTo(width, py(y)); ctx.stroke();
      if (Math.abs(y) > sy / 1000) ctx.fillText(tick(y, sy), 7, py(y));
    }
    ctx.strokeStyle = "rgba(217,207,244,.45)";
    if (xMin <= 0 && xMax >= 0) { ctx.beginPath(); ctx.moveTo(px(0), 0); ctx.lineTo(px(0), height); ctx.stroke(); }
    if (yMin <= 0 && yMax >= 0) { ctx.beginPath(); ctx.moveTo(0, py(0)); ctx.lineTo(width, py(0)); ctx.stroke(); }
    ctx.beginPath();
    ctx.strokeStyle = "#ac8fff";
    ctx.lineWidth = 2.4;
    ctx.lineJoin = "round";
    let drawing = false;
    let previousY = null;
    const samples = Math.ceil(width * 1.4);
    for (let i = 0; i <= samples; i++) {
      const x = xMin + i / samples * (xMax - xMin);
      let y;
      try { y = evaluate(graph.expression.value, app.graphMode, x, true); } catch { y = NaN; }
      const canvasY = py(y);
      if (!Number.isFinite(y) || !Number.isFinite(canvasY) || y < yMin - (yMax - yMin) || y > yMax + (yMax - yMin) ||
        (previousY !== null && Math.abs(canvasY - previousY) > height * 0.6)) {
        drawing = false;
        previousY = null;
        continue;
      }
      if (!drawing) { ctx.moveTo(px(x), canvasY); drawing = true; }
      else ctx.lineTo(px(x), canvasY);
      previousY = canvasY;
    }
    ctx.stroke();
    if (graph.pointer) {
      const x = xMin + graph.pointer.x / width * (xMax - xMin);
      const y = yMax - graph.pointer.y / height * (yMax - yMin);
      ctx.save();
      ctx.strokeStyle = "#ffffff65";
      ctx.setLineDash([4, 5]);
      ctx.beginPath(); ctx.moveTo(graph.pointer.x, 0); ctx.lineTo(graph.pointer.x, height);
      ctx.moveTo(0, graph.pointer.y); ctx.lineTo(width, graph.pointer.y); ctx.stroke();
      ctx.restore();
      $("#graph-coordinates").textContent = `x: ${tick(x, (xMax - xMin) / 1000)} · y: ${tick(y, (yMax - yMin) / 1000)}`;
    }
  }

  function plotGraph() {
    const status = $("#graph-status");
    try {
      const range = Object.fromEntries(Object.entries(graph.range).map(([key, input]) => [key, input.valueAsNumber]));
      if (Object.values(range).some((value) => !Number.isFinite(value)) ||
        range.xMin >= range.xMax || range.yMin >= range.yMax) {
        throw new Error("Revisa los límites: deben ser números y mínimo < máximo.");
      }
      let compiled = false;
      for (const sample of [-1.25, 0.5, 2.25]) {
        try {
          evaluate(graph.expression.value, app.graphMode, sample, true);
          compiled = true;
          break;
        } catch { /* A function can be undefined at a particular sample. */ }
      }
      if (!compiled) throw new Error("No se pudo interpretar la función en un punto válido.");
      graph.current = range;
      graph.pointer = null;
      $("#graph-title").textContent = `f(x) = ${graph.expression.value.trim()}`;
      $("#graph-range").textContent = `x: ${tick(range.xMin, niceStep(range.xMax - range.xMin))} a ${tick(range.xMax, niceStep(range.xMax - range.xMin))} · y: ${tick(range.yMin, niceStep(range.yMax - range.yMin))} a ${tick(range.yMax, niceStep(range.yMax - range.yMin))}`;
      $("#graph-coordinates").textContent = "x: — · y: —";
      drawGraph();
      status.classList.remove("error");
      status.textContent = "Función graficada correctamente.";
    } catch (error) {
      status.classList.add("error");
      status.textContent = error.message;
    }
  }

  function initGraph() {
    $("#graph-form").addEventListener("submit", (event) => { event.preventDefault(); plotGraph(); });
    $$("[data-example]").forEach((button) => button.addEventListener("click", () => {
      graph.expression.value = button.dataset.example;
      plotGraph();
    }));
    $$("[data-graph-mode]").forEach((button) => button.addEventListener("click", () => {
      app.graphMode = Number(button.dataset.graphMode);
      $$("[data-graph-mode]").forEach((item) => item.classList.toggle("selected", item === button));
      plotGraph();
    }));
    graph.canvas.addEventListener("pointermove", (event) => {
      const rect = graph.canvas.getBoundingClientRect();
      graph.pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      drawGraph();
    });
    graph.canvas.addEventListener("pointerleave", () => {
      graph.pointer = null;
      $("#graph-coordinates").textContent = "x: — · y: —";
      drawGraph();
    });
    if ("ResizeObserver" in window) new ResizeObserver(drawGraph).observe(graph.canvas);
    else window.addEventListener("resize", drawGraph);
    plotGraph();
  }

  function columnName(number) {
    let name = "";
    while (number > 0) {
      number--;
      name = String.fromCharCode(65 + number % 26) + name;
      number = Math.floor(number / 26);
    }
    return name;
  }

  function cellAddress(column, row) { return `${columnName(column)}${row}`; }

  function setCell(address, value) {
    withInput(address, (addressPtr, addressLength) => withInput(value, (valuePtr, valueLength) => {
      app.wasm.wasm_set_cell(addressPtr, addressLength, valuePtr, valueLength);
    }));
  }

  function cellValue(address) {
    withInput(address, (ptr, length) => app.wasm.wasm_cell_value(ptr, length));
    return wasmString(app.wasm.wasm_output_ptr(), app.wasm.wasm_output_len());
  }

  function buildSheet() {
    const head = $("#sheet-head");
    const body = $("#sheet-body");
    const header = document.createElement("tr");
    header.append(document.createElement("th"));
    for (let column = 1; column <= 8; column++) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = columnName(column);
      header.append(th);
    }
    head.replaceChildren(header);
    const fragment = document.createDocumentFragment();
    for (let row = 1; row <= 24; row++) {
      const tr = document.createElement("tr");
      const number = document.createElement("th");
      number.scope = "row";
      number.textContent = row;
      tr.append(number);
      for (let column = 1; column <= 8; column++) {
        const td = document.createElement("td");
        const cell = document.createElement("div");
        const address = cellAddress(column, row);
        cell.className = "sheet-cell";
        cell.dataset.address = address;
        cell.contentEditable = "true";
        cell.spellcheck = false;
        cell.setAttribute("role", "gridcell");
        cell.setAttribute("aria-label", address);
        cell.tabIndex = address === app.selectedCell ? 0 : -1;
        td.append(cell);
        tr.append(td);
      }
      fragment.append(tr);
    }
    body.replaceChildren(fragment);
  }

  function renderSheet() {
    $$(".sheet-cell").forEach((cell) => {
      if (document.activeElement === cell) return;
      const value = cellValue(cell.dataset.address);
      cell.textContent = value;
      cell.classList.toggle("error", value.startsWith("#"));
      cell.setAttribute("aria-selected", String(cell.dataset.address === app.selectedCell));
      cell.tabIndex = cell.dataset.address === app.selectedCell ? 0 : -1;
    });
    $("#selected-cell").textContent = app.selectedCell;
    if (document.activeElement !== $("#formula-input")) {
      $("#formula-input").value = app.sheetRaw?.get(app.selectedCell) || "";
    }
    $("#sheet-status").textContent = "Cambios en la hoja · 8 columnas × 24 filas";
  }

  function selectCell(address, focus = false) {
    app.selectedCell = address;
    $("#selected-cell").textContent = address;
    $("#formula-input").value = app.sheetRaw?.get(address) || "";
    renderSheet();
    if (focus) $(`.sheet-cell[data-address="${address}"]`)?.focus();
    $("#formula-input").value = app.sheetRaw?.get(address) || "";
  }

  function commitSheetCell(address, value) {
    app.sheetRaw ||= new Map();
    if (value) app.sheetRaw.set(address, value);
    else app.sheetRaw.delete(address);
    setCell(address, value);
    renderSheet();
    $("#sheet-status").textContent = "Cambios sin guardar · Hoja1";
  }

  function initSheet() {
    app.sheetRaw = new Map();
    buildSheet();
    $("#sheet-body").addEventListener("focusin", (event) => {
      const cell = event.target.closest(".sheet-cell");
      if (cell) selectCell(cell.dataset.address);
    });
    $("#sheet-body").addEventListener("input", (event) => {
      const cell = event.target.closest(".sheet-cell");
      if (!cell) return;
      app.selectedCell = cell.dataset.address;
      $("#selected-cell").textContent = app.selectedCell;
      $("#formula-input").value = cell.textContent;
    });
    $("#sheet-body").addEventListener("focusout", (event) => {
      const cell = event.target.closest(".sheet-cell");
      if (cell) commitSheetCell(cell.dataset.address, cell.textContent.trim());
    });
    $("#sheet-body").addEventListener("keydown", (event) => {
      const cell = event.target.closest(".sheet-cell");
      if (!cell) return;
      const [column, row] = [cell.dataset.address.match(/^[A-Z]+/)[0], Number(cell.dataset.address.match(/\d+$/)[0])];
      let nextColumn = column.charCodeAt(0) - 64;
      let nextRow = row;
      if (event.key === "Enter" || event.key === "Tab" || event.key.startsWith("Arrow")) {
        event.preventDefault();
        commitSheetCell(cell.dataset.address, cell.textContent.trim());
        if (event.key === "Enter") nextRow += event.shiftKey ? -1 : 1;
        if (event.key === "Tab") nextColumn += event.shiftKey ? -1 : 1;
        if (event.key === "ArrowUp") nextRow--;
        if (event.key === "ArrowDown") nextRow++;
        if (event.key === "ArrowLeft") nextColumn--;
        if (event.key === "ArrowRight") nextColumn++;
        nextColumn = Math.max(1, Math.min(8, nextColumn));
        nextRow = Math.max(1, Math.min(24, nextRow));
        selectCell(cellAddress(nextColumn, nextRow), true);
      }
    });
    $("#formula-input").addEventListener("input", (event) => commitSheetCell(app.selectedCell, event.target.value));
    $("#formula-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const row = Math.min(24, Number(app.selectedCell.match(/\d+$/)[0]) + 1);
        selectCell(`${app.selectedCell.match(/^[A-Z]+/)[0]}${row}`, true);
      } else if (event.key === "Escape") {
        event.target.value = app.sheetRaw.get(app.selectedCell) || "";
      }
    });
    $("#sheet-clear").addEventListener("click", () => {
      app.wasm.wasm_clear_sheet();
      app.sheetRaw.clear();
      selectCell("A1");
    });
    $("#sheet-save").addEventListener("click", () => {
      app.wasm.wasm_export_ods();
      download("Hoja-de-calculo.ods", wasmOutput(), "application/vnd.oasis.opendocument.spreadsheet");
      $("#sheet-status").textContent = "Archivo ODS guardado.";
    });
    selectCell("A1");
  }

  function safeFileBaseName(value) {
    return (value || "Documento").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim().slice(0, 80) || "Documento";
  }

  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function markdownInline(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent.replace(/([\\`*_{}\[\]()#+.!|<>-])/g, "\\$1");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const children = [...node.childNodes].map(markdownInline).join("");
    switch (node.tagName) {
      case "STRONG": case "B": return `**${children}**`;
      case "EM": case "I": return `*${children}*`;
      case "S": return `~~${children}~~`;
      case "U": return `<u>${children}</u>`;
      case "BR": return "  \n";
      case "A": return `[${children}](${node.getAttribute("href") || ""})`;
      case "TABLE": return node.outerHTML;
      default: return children;
    }
  }

  function documentMarkdown() {
    return [...$("#writer-editor").children].map((node) => {
      const text = [...node.childNodes].map(markdownInline).join("");
      if (/^H[1-6]$/.test(node.tagName)) return `${"#".repeat(Number(node.tagName[1]))} ${text}`;
      if (node.tagName === "BLOCKQUOTE") return `> ${text}`;
      if (node.tagName === "UL" || node.tagName === "OL") {
        return [...node.children].map((item, index) => `${node.tagName === "OL" ? `${index + 1}.` : "-"} ${markdownInline(item)}`).join("\n");
      }
      return text;
    }).join("\n\n") + "\n";
  }

  function cleanHtml(source) {
    const allowed = new Set(["P", "DIV", "BR", "H1", "H2", "H3", "H4", "H5", "H6", "B", "STRONG", "I", "EM", "U", "S", "SPAN", "FONT", "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "CODE", "A", "HR", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD"]);
    const blocked = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "FORM", "SVG", "MATH"]);
    const styleProperties = new Set(["color", "background-color", "font-family", "font-size", "font-weight", "font-style", "text-decoration", "text-align"]);
    const parsed = new DOMParser().parseFromString(source, "text/html");
    const walk = (node) => {
      [...node.childNodes].forEach((child) => {
        if (child.nodeType !== Node.ELEMENT_NODE) return;
        if (blocked.has(child.tagName)) {
          child.remove();
          return;
        }
        walk(child);
        if (!allowed.has(child.tagName)) {
          child.replaceWith(...child.childNodes);
          return;
        }
        [...child.attributes].forEach((attribute) => {
          if (child.tagName === "A" && attribute.name === "href" &&
            /^(https?:|mailto:|#|\/|\.\.?\/)/i.test(attribute.value) && !attribute.value.startsWith("//")) return;
          if (attribute.name === "style") {
            const safe = attribute.value.split(";").map((rule) => rule.trim()).filter(Boolean).flatMap((rule) => {
              const separator = rule.indexOf(":");
              if (separator < 0) return [];
              const property = rule.slice(0, separator).trim().toLowerCase();
              const value = rule.slice(separator + 1).trim();
              if (!styleProperties.has(property) || /url\s*\(|expression\s*\(|javascript:/i.test(value) || !CSS.supports(property, value)) return [];
              return [`${property}: ${value}`];
            });
            if (safe.length) child.setAttribute("style", safe.join("; "));
            else child.removeAttribute("style");
            return;
          }
          if ((child.tagName === "TD" || child.tagName === "TH") &&
            ["colspan", "rowspan"].includes(attribute.name) && /^\d{1,2}$/.test(attribute.value)) return;
          if (child.tagName !== "A" || attribute.name !== "href") {
            child.removeAttribute(attribute.name);
          }
        });
      });
    };
    walk(parsed.body);
    return parsed.body.innerHTML;
  }

  async function unzipEntry(buffer, target) {
    const view = new DataView(buffer);
    const maxEntrySize = 20 * 1024 * 1024;
    const checksum = (bytes) => {
      let crc = 0xffffffff;
      for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }
      return (crc ^ 0xffffffff) >>> 0;
    };
    for (let offset = 0; offset + 30 < view.byteLength;) {
      if (view.getUint32(offset, true) !== 0x04034b50) break;
      const method = view.getUint16(offset + 8, true);
      const expectedCrc = view.getUint32(offset + 14, true);
      const compressed = view.getUint32(offset + 18, true);
      const uncompressed = view.getUint32(offset + 22, true);
      const nameLength = view.getUint16(offset + 26, true);
      const extraLength = view.getUint16(offset + 28, true);
      const nameStart = offset + 30;
      const name = decoder.decode(new Uint8Array(buffer, nameStart, nameLength));
      const dataStart = nameStart + nameLength + extraLength;
      const bytes = new Uint8Array(buffer, dataStart, compressed);
      if (name === target) {
        if (uncompressed > maxEntrySize) throw new Error("La entrada del archivo ODT supera el límite de 20 MB.");
        if (method === 0) {
          if (bytes.length !== uncompressed || checksum(bytes) !== expectedCrc) throw new Error("La verificación del contenido ODT falló.");
          return decoder.decode(bytes);
        }
        if (method === 8 && "DecompressionStream" in window) {
          const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
          const reader = stream.getReader();
          const chunks = [];
          let total = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > maxEntrySize) {
              await reader.cancel();
              throw new Error("El contenido descomprimido ODT supera el límite de 20 MB.");
            }
            chunks.push(value);
          }
          const output = new Uint8Array(total);
          let writeOffset = 0;
          chunks.forEach((chunk) => { output.set(chunk, writeOffset); writeOffset += chunk.length; });
          if (output.length !== uncompressed || checksum(output) !== expectedCrc) throw new Error("La verificación del contenido ODT falló.");
          return decoder.decode(output);
        }
        throw new Error("Este navegador no puede descomprimir esta entrada ODT.");
      }
      offset = dataStart + compressed;
    }
    throw new Error(`No se encontró ${target} en el archivo.`);
  }

  function odtToHtml(xml) {
    const parsed = new DOMParser().parseFromString(xml, "application/xml");
    if (parsed.querySelector("parsererror")) throw new Error("El XML del archivo ODT no es válido.");
    const textNamespace = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
    const convert = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.textContent || "");
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      if (node.namespaceURI === textNamespace && node.localName === "line-break") return "<br>";
      const children = [...node.childNodes].map(convert).join("");
      if (node.namespaceURI !== textNamespace) return children;
      if (node.localName === "h") {
        const level = Math.min(6, Number(node.getAttributeNS(textNamespace, "outline-level")) || 1);
        return `<h${level}>${children}</h${level}>`;
      }
      if (node.localName === "p") return `<p>${children || "<br>"}</p>`;
      if (node.localName === "span") return children;
      if (node.localName === "a") return children;
      if (node.localName === "list") return `<ul>${[...node.children].map((item) => `<li>${[...item.children].map(convert).join("")}</li>`).join("")}</ul>`;
      return children;
    };
    const textRoot = parsed.getElementsByTagNameNS("urn:oasis:names:tc:opendocument:xmlns:office:1.0", "text")[0];
    return textRoot ? [...textRoot.childNodes].map(convert).join("") : "";
  }

  function writerOdf() {
    const styleMap = new Map();
    const definitions = [];
    let styleIndex = 0;
    const xmlEscape = (value) => value.replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
    })[character]);
    const cssColor = (value) => {
      const match = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
      if (match) return `#${match.slice(1, 4).map((part) => Number(part).toString(16).padStart(2, "0")).join("")}`;
      return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : "";
    };
    const textStyle = (node) => {
      const props = {};
      const color = cssColor(node.style.color);
      const background = cssColor(node.style.backgroundColor);
      if (color) props["fo:color"] = color;
      if (background) props["fo:background-color"] = background;
      if (node.style.fontWeight === "bold" || ["B", "STRONG"].includes(node.tagName)) props["fo:font-weight"] = "bold";
      if (node.style.fontStyle === "italic" || ["I", "EM"].includes(node.tagName)) props["fo:font-style"] = "italic";
      if (node.style.textDecorationLine.includes("underline") || node.tagName === "U") props["style:text-underline-style"] = "solid";
      if (node.style.textDecorationLine.includes("line-through") || node.tagName === "S") props["style:text-line-through-style"] = "solid";
      if (node.style.fontFamily) props["fo:font-family"] = node.style.fontFamily.split(",")[0].replace(/^["']|["']$/g, "");
      const size = node.style.fontSize.match(/^(\d+(?:\.\d+)?)(pt|px)$/);
      if (size) props["fo:font-size"] = `${size[2] === "px" ? Number(size[1]) * 0.75 : size[1]}pt`;
      const entries = Object.entries(props);
      if (!entries.length) return "";
      const key = JSON.stringify(entries);
      if (styleMap.has(key)) return styleMap.get(key);
      const name = `Text${++styleIndex}`;
      const attrs = entries.map(([attribute, value]) => `${attribute}="${xmlEscape(value)}"`).join(" ");
      definitions.push(`<style:style style:name="${name}" style:family="text"><style:text-properties ${attrs}/></style:style>`);
      styleMap.set(key, name);
      return name;
    };
    const inline = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return xmlEscape(node.textContent || "");
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      if (node.tagName === "BR") return "<text:line-break/>";
      const content = [...node.childNodes].map(inline).join("");
      if (node.tagName === "A") {
        const href = node.getAttribute("href") || "";
        return /^(https?:|mailto:|#|\/|\.\.?\/)/i.test(href) && !href.startsWith("//")
          ? `<text:a xlink:href="${xmlEscape(href)}">${content}</text:a>` : content;
      }
      if (["B", "STRONG", "I", "EM", "U", "S", "SPAN", "FONT"].includes(node.tagName)) {
        const style = textStyle(node);
        return style ? `<text:span text:style-name="${style}">${content}</text:span>` : content;
      }
      return content;
    };
    const blocks = (nodes) => [...nodes].map((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.trim();
        return text ? `<text:p>${xmlEscape(text)}</text:p>` : "";
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const tag = node.tagName;
      if (tag === "UL" || tag === "OL") {
        return `<text:list>${[...node.children].filter((item) => item.tagName === "LI")
          .map((item) => `<text:list-item>${blocks(item.childNodes) || `<text:p>${inline(item)}</text:p>`}</text:list-item>`).join("")}</text:list>`;
      }
      if (tag === "TABLE") {
        const rows = [...node.querySelectorAll("tr")].map((row) =>
          `<table:table-row>${[...row.children].map((cell) => `<table:table-cell><text:p>${inline(cell)}</text:p></table:table-cell>`).join("")}</table:table-row>`).join("");
        return `<table:table>${rows}</table:table>`;
      }
      const content = inline(node);
      if (/^H[1-6]$/.test(tag)) return `<text:h text:outline-level="${tag[1]}">${content}</text:h>`;
      if (tag === "HR") return "<text:p>—</text:p>";
      return `<text:p>${content || "<text:line-break/>"}</text:p>`;
    }).join("");
    return { body: blocks($("#writer-editor").childNodes), styles: definitions.join("") };
  }

  async function openWriterFile(file) {
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("El archivo supera el límite de 5 MB.");
      const extension = file.name.split(".").pop().toLowerCase();
      let html;
      if (extension === "odt") {
        const content = await unzipEntry(await file.arrayBuffer(), "content.xml");
        html = odtToHtml(content);
      } else {
        const source = await file.text();
        if (extension === "html" || extension === "htm") html = cleanHtml(source);
        else if (extension === "md") html = source.split(/\r?\n/).map((line) => {
          if (/^#{1,6}\s/.test(line)) {
            const level = line.match(/^#+/)[0].length;
            return `<h${level}>${escapeHtml(line.replace(/^#+\s*/, ""))}</h${level}>`;
          }
          return `<p>${escapeHtml(line) || "<br>"}</p>`;
        }).join("");
        else html = source.split(/\r?\n/).map((line) => `<p>${escapeHtml(line) || "<br>"}</p>`).join("");
      }
      $("#writer-editor").innerHTML = cleanHtml(html);
      $("#writer-status").textContent = `Abierto: ${file.name}`;
      updateWriter();
    } catch (error) {
      $("#writer-status").textContent = `No se pudo abrir: ${error.message}`;
    } finally {
      $("#writer-file").value = "";
    }
  }

  function updateWriter() {
    const text = $("#writer-editor").innerText;
    const count = withInput(text, (ptr, length) => app.wasm.wasm_word_count(ptr, length));
    $("#writer-count").textContent = `${count} ${count === 1 ? "palabra" : "palabras"}`;
    $("#writer-status").textContent = "Cambios en el documento";
    try {
      localStorage.setItem("wasm-writer-draft", JSON.stringify({
        html: cleanHtml($("#writer-editor").innerHTML),
        width: $("#writer-width").value,
        spacing: $("#writer-spacing").value,
        pageColor: $("#writer-page-color").value,
        updatedAt: new Date().toISOString()
      }));
    } catch (error) {
      $("#writer-status").textContent = `No se pudo guardar el borrador local: ${error.message}`;
    }
  }

  function saveWriter() {
    const editor = $("#writer-editor");
    const format = $("#writer-format").value;
    const base = safeFileBaseName("Documento");
    if (format === "html") {
      const width = $("#writer-width").value;
      const spacing = $("#writer-spacing").value;
      const pageColor = $("#writer-page-color").value;
      download(`${base}.html`, `<!doctype html><html lang="es"><meta charset="utf-8"><title>${base}</title><style>body{font-family:Arial,sans-serif;line-height:${spacing};max-width:${width};margin:40px auto;padding:24px;background:${pageColor}}</style><body>${cleanHtml(editor.innerHTML)}</body></html>`, "text/html");
    } else if (format === "md") {
      download(`${base}.md`, documentMarkdown(), "text/markdown");
    } else if (format === "txt") {
      download(`${base}.txt`, editor.innerText, "text/plain");
    } else {
      const odf = writerOdf();
      withInput(odf.body, (bodyPtr, bodyLength) => withInput(odf.styles, (stylesPtr, stylesLength) => {
        app.wasm.wasm_export_odt_xml(bodyPtr, bodyLength, stylesPtr, stylesLength);
      }));
      const error = wasmString(app.wasm.wasm_error_ptr(), app.wasm.wasm_error_len());
      if (error) throw new Error(error);
      download(`${base}.odt`, wasmOutput(), "application/vnd.oasis.opendocument.text");
    }
    $("#writer-status").textContent = `Documento exportado como ${format.toUpperCase()}`;
  }

  function initWriter() {
    const editor = $("#writer-editor");
    editor.addEventListener("input", updateWriter);
    $$(".writer-toolbar [data-command]").forEach((button) => button.addEventListener("click", () => {
      editor.focus();
      document.execCommand("styleWithCSS", false, true);
      document.execCommand(button.dataset.command, false);
      updateWriter();
    }));
    $("#writer-block").addEventListener("change", (event) => {
      editor.focus();
      document.execCommand("styleWithCSS", false, true);
      document.execCommand("formatBlock", false, `<${event.target.value}>`);
      updateWriter();
    });
    $("#writer-font").addEventListener("change", (event) => {
      editor.focus();
      document.execCommand("styleWithCSS", false, true);
      document.execCommand("fontName", false, event.target.value);
      updateWriter();
    });
    $("#writer-size").addEventListener("change", (event) => {
      editor.focus();
      document.execCommand("styleWithCSS", false, true);
      document.execCommand("fontSize", false, event.target.value);
      updateWriter();
    });
    for (const [selector, command] of [["#writer-color", "foreColor"], ["#writer-highlight", "hiliteColor"]]) {
      $(selector).addEventListener("input", (event) => {
        editor.focus();
        document.execCommand("styleWithCSS", false, true);
        document.execCommand(command, false, event.target.value);
        updateWriter();
      });
    }
    $("#writer-width").addEventListener("change", (event) => {
      editor.style.width = `min(${event.target.value}, 100%)`;
      updateWriter();
    });
    $("#writer-spacing").addEventListener("change", (event) => {
      editor.style.lineHeight = event.target.value;
      updateWriter();
    });
    $("#writer-page-color").addEventListener("input", (event) => {
      editor.style.backgroundColor = event.target.value;
      updateWriter();
    });
    $("#writer-link").addEventListener("click", () => {
      const url = window.prompt("Dirección del enlace (https://, mailto: o ruta relativa):");
      if (!url || !/^(https?:|mailto:|#|\/|\.\.?\/)/i.test(url) || url.startsWith("//")) return;
      editor.focus();
      document.execCommand("createLink", false, url);
      updateWriter();
    });
    $("#writer-table").addEventListener("click", () => {
      editor.focus();
      const rows = Array.from({ length: 3 }, () => `<tr>${Array.from({ length: 3 }, () => "<td>&nbsp;</td>").join("")}</tr>`).join("");
      document.execCommand("insertHTML", false, `<table><tbody>${rows}</tbody></table><p><br></p>`);
      updateWriter();
    });
    $("#writer-date").addEventListener("click", () => {
      editor.focus();
      document.execCommand("insertText", false, new Intl.DateTimeFormat("es", { dateStyle: "long" }).format(new Date()));
      updateWriter();
    });
    $("#writer-print").addEventListener("click", () => window.print());
    $("#writer-new").addEventListener("click", () => {
      editor.innerHTML = "<p><br></p>";
      updateWriter();
      editor.focus();
    });
    $("#writer-open").addEventListener("click", () => $("#writer-file").click());
    $("#writer-file").addEventListener("change", () => openWriterFile($("#writer-file").files?.[0]));
    $("#writer-save").addEventListener("click", () => {
      try { saveWriter(); } catch (error) { $("#writer-status").textContent = `No se pudo guardar: ${error.message}`; }
    });
    try {
      const draft = JSON.parse(localStorage.getItem("wasm-writer-draft") || "null");
      if (draft?.html) {
        editor.innerHTML = cleanHtml(draft.html);
        if (["680px", "760px", "980px"].includes(draft.width)) {
          $("#writer-width").value = draft.width;
          editor.style.width = `min(${draft.width}, 100%)`;
        }
        if (["1.2", "1.6", "2"].includes(draft.spacing)) {
          $("#writer-spacing").value = draft.spacing;
          editor.style.lineHeight = draft.spacing;
        }
        if (/^#[0-9a-f]{6}$/i.test(draft.pageColor || "")) {
          $("#writer-page-color").value = draft.pageColor;
          editor.style.backgroundColor = draft.pageColor;
        }
        $("#writer-status").textContent = "Borrador anterior restaurado";
      }
    } catch (error) {
      $("#writer-status").textContent = `No se pudo restaurar el borrador: ${error.message}`;
    }
    updateWriter();
  }

  async function initialize() {
    const status = $("#engine-status");
    try {
      const response = await fetch("./pkg/aplicaciones_wasm.wasm");
      if (!response.ok) throw new Error(`No se pudo cargar WebAssembly (${response.status}).`);
      const bytes = await response.arrayBuffer();
      const result = await WebAssembly.instantiate(bytes, {});
      app.wasm = result.instance.exports;
      status.textContent = "Motor WASM activo";
      status.classList.add("ready");
      initNavigation();
      initCalculator();
      initGraph();
      initSheet();
      initWriter();
    } catch (error) {
      status.textContent = "No se pudo cargar WASM";
      status.title = error.message;
      document.querySelectorAll("button").forEach((button) => {
        if (!button.dataset.screen && button.type !== "button") button.disabled = true;
      });
      console.error("Error al iniciar el motor WebAssembly:", error);
    }
  }

  initialize();
})();
