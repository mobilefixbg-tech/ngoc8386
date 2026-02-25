const puppeteer = require("puppeteer");
const cron = require("node-cron");
const fs = require("fs-extra");
const path = require("path");

const dataPath = path.join(__dirname, "history.json");
const sourceUrl = process.env.KQXS_URL || "https://link-quay-thu.com";
const PRIZE_CONFIG = [
  {
    key: "gdb",
    label: "ĐB",
    aliases: ["db", "gdb", "giai db", "dac biet", "giai dac biet"]
  },
  { key: "g1", label: "G1", aliases: ["g1", "giai 1", "giai nhat"] },
  { key: "g2", label: "G2", aliases: ["g2", "giai 2", "giai nhi"] },
  { key: "g3", label: "G3", aliases: ["g3", "giai 3", "giai ba"] },
  { key: "g4", label: "G4", aliases: ["g4", "giai 4", "giai bon", "giai tu"] },
  { key: "g5", label: "G5", aliases: ["g5", "giai 5", "giai nam"] },
  { key: "g6", label: "G6", aliases: ["g6", "giai 6", "giai sau"] },
  { key: "g7", label: "G7", aliases: ["g7", "giai 7", "giai bay"] },
  { key: "g8", label: "G8", aliases: ["g8", "giai 8", "giai tam"] }
];
const STATION_CATALOG = [
  { name: "An Giang", aliases: ["an giang"] },
  { name: "Bạc Liêu", aliases: ["bac lieu"] },
  { name: "Bến Tre", aliases: ["ben tre"] },
  { name: "Bình Dương", aliases: ["binh duong"] },
  { name: "Bình Phước", aliases: ["binh phuoc"] },
  { name: "Bình Thuận", aliases: ["binh thuan"] },
  { name: "Cà Mau", aliases: ["ca mau"] },
  { name: "Cần Thơ", aliases: ["can tho"] },
  { name: "Đà Lạt", aliases: ["da lat"] },
  { name: "Đồng Nai", aliases: ["dong nai"] },
  { name: "Đồng Tháp", aliases: ["dong thap"] },
  { name: "Hậu Giang", aliases: ["hau giang"] },
  { name: "Kiên Giang", aliases: ["kien giang"] },
  { name: "Long An", aliases: ["long an"] },
  { name: "Sóc Trăng", aliases: ["soc trang"] },
  { name: "Tây Ninh", aliases: ["tay ninh"] },
  { name: "Tiền Giang", aliases: ["tien giang"] },
  { name: "TP HCM", aliases: ["tp hcm", "tphcm", "tp ho chi minh", "ho chi minh"] },
  { name: "Trà Vinh", aliases: ["tra vinh"] },
  { name: "Vĩnh Long", aliases: ["vinh long"] },
  {
    name: "Vũng Tàu",
    aliases: ["vung tau", "ba ria vung tau", "ba ria - vung tau", "brvt"]
  }
];

let isCrawling = false;
let cronTask = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clean(text) {
  return String(text || "").replace(/\D/g, "");
}

function cleanWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeVietnamese(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase();
}

function normalizeTokenText(text) {
  return normalizeVietnamese(text)
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findStationsInText(text) {
  const normalizedText = normalizeTokenText(text);
  if (!normalizedText) return [];

  const paddedText = ` ${normalizedText} `;
  const found = [];

  STATION_CATALOG.forEach((station) => {
    let firstIndex = Infinity;
    station.aliases.forEach((alias) => {
      const normalizedAlias = normalizeTokenText(alias);
      if (!normalizedAlias) return;
      const idx = paddedText.indexOf(` ${normalizedAlias} `);
      if (idx !== -1 && idx < firstIndex) {
        firstIndex = idx;
      }
    });
    if (firstIndex !== Infinity) {
      found.push({ station: station.name, index: firstIndex });
    }
  });

  found.sort((a, b) => a.index - b.index);
  return found.map((item) => item.station);
}

function detectStations(rawText, stationHint) {
  const hint = stationHint && typeof stationHint === "object" ? stationHint : {};
  const sourceText = [rawText, hint.title, hint.url, hint.hostname]
    .map((item) => cleanWhitespace(item))
    .filter(Boolean)
    .join(" ");
  return findStationsInText(sourceText);
}

function normalizeStationName(name) {
  const value = cleanWhitespace(name);
  if (!value) return "Chưa rõ đài";
  const normalized = normalizeVietnamese(value);
  if (normalized === "thu cong" || normalized === "khong ro dai") {
    return "Chưa rõ đài";
  }
  if (normalized === "mien nam") return "Miền Nam";
  if (normalized === "mien trung") return "Miền Trung";
  if (normalized === "mien bac") return "Miền Bắc";

  const stationList = findStationsInText(value);
  if (stationList.length === 1) {
    return stationList[0];
  }
  if (stationList.length > 1) {
    return stationList.join(" | ");
  }
  return value;
}

function extractNumbers(text) {
  const matches = String(text || "").match(/\d+/g);
  if (!matches) return [];
  return matches.map((item) => clean(item)).filter(Boolean);
}

function detectPrizeKey(line) {
  const normalized = normalizeVietnamese(line);

  for (const prize of PRIZE_CONFIG) {
    for (const alias of prize.aliases) {
      const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matcher = new RegExp(`(^|\\b)${escapedAlias}(\\b|$)`, "i");
      if (matcher.test(normalized)) {
        return prize.key;
      }
    }
  }

  return null;
}

function sanitizeByPrizeKey(numbers, key) {
  const list = [...numbers];
  if (key && key.startsWith("g") && key !== "gdb") {
    const expected = key.slice(1);
    if (list[0] === expected && list[0].length <= 2) {
      list.shift();
    }
  }
  return list;
}

function inferStationFromHint(stationHint) {
  const hint = stationHint && typeof stationHint === "object" ? stationHint : {};
  const title = cleanWhitespace(hint.title || "");
  const hostname = cleanWhitespace(hint.hostname || "");
  const fullUrl = cleanWhitespace(hint.url || "");

  if (title) {
    const titleMatch = title.match(/xổ\s*số(?:\s*kiến\s*thiết)?\s*([^\-|]+)/i);
    if (titleMatch?.[1]) {
      const fromTitle = cleanWhitespace(
        titleMatch[1]
          .replace(/\b(hôm nay|trực tiếp|kết quả|ngày)\b/gi, "")
          .replace(/[:|]/g, " ")
      );
      if (fromTitle) return normalizeStationName(fromTitle);
    }
  }

  const source = `${hostname} ${fullUrl}`.toLowerCase();
  if (source.includes("xsmn")) return "Miền Nam";
  if (source.includes("xsmt")) return "Miền Trung";
  if (source.includes("xsmb")) return "Miền Bắc";

  if (hostname) {
    const hostLabel = hostname.replace(/^www\./i, "").split(".")[0];
    if (hostLabel) {
      return normalizeStationName(`Nguồn ${hostLabel.toUpperCase()}`);
    }
  }

  return "";
}

function parseStation(rawText, stationHint) {
  const raw = String(rawText || "");
  const daiMatch = raw.match(/(?:Đài|Dai)\s*[:\-]?\s*([^\n\r|,;]+)/i);
  if (daiMatch?.[1]) {
    return normalizeStationName(daiMatch[1].slice(0, 80));
  }

  const mienMatch = raw.match(/(?:Miền|Mien)\s*(Bắc|Trung|Nam)/i);
  if (mienMatch?.[1]) {
    return normalizeStationName(`Miền ${mienMatch[1].trim()}`);
  }

  const xoSoMatch = raw.match(/xổ\s*số(?:\s*kiến\s*thiết)?\s*([^\n\r|,;]+)/i);
  if (xoSoMatch?.[1]) {
    return normalizeStationName(xoSoMatch[1].slice(0, 80));
  }

  const detectedStations = detectStations(rawText, stationHint);
  if (detectedStations.length === 1) {
    return normalizeStationName(detectedStations[0]);
  }
  if (detectedStations.length > 1) {
    return normalizeStationName(detectedStations.join(" | "));
  }

  const fromHint = inferStationFromHint(stationHint);
  if (fromHint) {
    return normalizeStationName(fromHint);
  }

  return "Chưa rõ đài";
}

function parseDrawDate(rawText) {
  const raw = String(rawText || "");
  const dateMatch = raw.match(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/);
  return dateMatch ? dateMatch[0] : "";
}

function parseManualKQXS(rawText, stationHint) {
  const lines = String(rawText || "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  const map = {
    gdb: [],
    g1: [],
    g2: [],
    g3: [],
    g4: [],
    g5: [],
    g6: [],
    g7: [],
    g8: []
  };

  let currentKey = null;

  lines.forEach((line) => {
    const normalized = normalizeVietnamese(line);
    const detectedKey = detectPrizeKey(normalized);

    if (detectedKey) {
      currentKey = detectedKey;
      const lineNumbers = sanitizeByPrizeKey(extractNumbers(line), detectedKey);
      if (lineNumbers.length) {
        map[detectedKey].push(...lineNumbers);
      }
      return;
    }

    if (!currentKey) return;

    if (
      normalized.includes("ket qua") ||
      normalized.includes("xo so") ||
      normalized.includes("kqxs") ||
      normalized.includes("thu ")
    ) {
      return;
    }

    const lineNumbers = extractNumbers(line);
    if (lineNumbers.length) {
      map[currentKey].push(...lineNumbers);
    }
  });

  const rows = PRIZE_CONFIG.map((cfg) => ({
    key: cfg.key,
    label: cfg.label,
    numbers: map[cfg.key]
  })).filter((row) => row.numbers.length);

  const allNumbers = rows.flatMap((row) => row.numbers);

  if (!allNumbers.length) {
    return null;
  }

  return {
    station: parseStation(rawText, stationHint),
    drawDate: parseDrawDate(rawText),
    prizes: rows,
    numbers: allNumbers,
    giaiDB: map.gdb[0] || "",
    giai7: map.g7 || [],
    giai8: map.g8 || []
  };
}

function splitTicketByStations(ticket, stations) {
  if (!ticket || !Array.isArray(ticket.prizes) || !ticket.prizes.length) {
    return [];
  }

  const stationList = Array.isArray(stations)
    ? stations.map((name) => normalizeStationName(name)).filter(Boolean)
    : [];
  if (stationList.length < 2) {
    return [];
  }

  const rowsByStation = stationList.map(() => []);
  for (const row of ticket.prizes) {
    const rowNumbers = Array.isArray(row?.numbers)
      ? row.numbers.map((item) => clean(item)).filter(Boolean)
      : [];
    if (!rowNumbers.length) {
      continue;
    }

    if (rowNumbers.length % stationList.length !== 0) {
      return [];
    }

    const chunkSize = rowNumbers.length / stationList.length;
    if (chunkSize < 1) {
      return [];
    }

    for (let i = 0; i < stationList.length; i += 1) {
      const start = i * chunkSize;
      const end = start + chunkSize;
      const part = rowNumbers.slice(start, end);
      rowsByStation[i].push({
        key: row.key,
        label: row.label,
        numbers: part
      });
    }
  }

  return stationList
    .map((station, index) => {
      const prizes = rowsByStation[index].filter(
        (row) => Array.isArray(row.numbers) && row.numbers.length
      );
      const numbers = prizes.flatMap((row) => row.numbers);
      if (!numbers.length) {
        return null;
      }

      const gdbRow = prizes.find((row) => row.key === "gdb");
      const g7Row = prizes.find((row) => row.key === "g7");
      const g8Row = prizes.find((row) => row.key === "g8");

      return {
        station,
        drawDate: ticket.drawDate || "",
        prizes,
        numbers,
        giaiDB: gdbRow?.numbers?.[0] || "",
        giai7: Array.isArray(g7Row?.numbers) ? g7Row.numbers : [],
        giai8: Array.isArray(g8Row?.numbers) ? g8Row.numbers : []
      };
    })
    .filter(Boolean);
}

function resolveStationForItem(item) {
  const direct = normalizeStationName(
    String(item?.ticket?.station || item?.station || "").trim()
  );
  if (direct !== "Chưa rõ đài") {
    return direct;
  }

  const hinted = parseStation(
    String(item?.rawText || ""),
    item?.stationHint && typeof item.stationHint === "object"
      ? item.stationHint
      : {}
  );
  return normalizeStationName(hinted);
}

async function saveHistory(newData) {
  let history = [];

  if (await fs.pathExists(dataPath)) {
    const fileData = await fs.readJson(dataPath);
    if (Array.isArray(fileData)) {
      history = fileData;
    }
  }

  history.push(newData);
  await fs.writeJson(dataPath, history, { spaces: 2 });
}

async function crawlKQXS() {
  if (isCrawling) {
    console.log("Bỏ qua: crawl trước đó vẫn đang chạy");
    return null;
  }

  isCrawling = true;
  let browser;

  try {
    console.log("Đang mở web...");

    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.goto(sourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await sleep(2000);

    const data = await page.evaluate(() => {
      const normalize = (text) => String(text || "").replace(/\D/g, "");

      return {
        date: new Date().toISOString(),
        giaiDB: normalize(document.querySelector(".giai-db")?.innerText),
        giai7: Array.from(document.querySelectorAll(".giai-7")).map((el) =>
          normalize(el.innerText)
        ),
        giai8: Array.from(document.querySelectorAll(".giai-8")).map((el) =>
          normalize(el.innerText)
        )
      };
    });

    if (!data.giaiDB) {
      console.log("Không lấy được dữ liệu!");
      return null;
    }

    await saveHistory(data);
    console.log("Đã cập nhật KQXS:", data);
    return data;
  } catch (err) {
    console.error("Lỗi crawl:", err.message);
    return null;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        console.error("Lỗi đóng browser:", closeErr.message);
      }
    }
    isCrawling = false;
  }
}

function thongKeTop(numbers, limit = 10) {
  const count = {};

  numbers.forEach((entry) => {
    const rawValue =
      entry && typeof entry === "object" ? entry.number : entry;
    const dai =
      entry && typeof entry === "object"
        ? String(entry.station || "Tổng hợp")
        : "Tổng hợp";

    const key = clean(rawValue);
    if (!key) return;
    const normalized = key.length >= 2 ? key.slice(-2) : key;
    const counterKey = `${dai}@@${normalized}`;
    count[counterKey] = (count[counterKey] || 0) + 1;
  });

  return Object.entries(count)
    .map(([counterKey, value]) => {
      const [dai, number] = counterKey.split("@@");
      return { number, count: value, dai };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

async function thongKe(limit = 10) {
  if (!(await fs.pathExists(dataPath))) {
    return [];
  }

  const history = await fs.readJson(dataPath);
  if (!Array.isArray(history)) {
    return [];
  }

  const allNumbers = [];

  history.forEach((item) => {
    const station = resolveStationForItem(item);

    if (Array.isArray(item.numbers) && item.numbers.length) {
      item.numbers.forEach((number) =>
        allNumbers.push({ number, station })
      );
      return;
    }

    allNumbers.push({ number: item.giaiDB, station });
    (item.giai7 || []).forEach((number) =>
      allNumbers.push({ number, station })
    );
    (item.giai8 || []).forEach((number) =>
      allNumbers.push({ number, station })
    );
  });

  return thongKeTop(allNumbers, limit);
}

async function thongKeTheoDai(limit = 10) {
  if (!(await fs.pathExists(dataPath))) {
    return [];
  }

  const history = await fs.readJson(dataPath);
  if (!Array.isArray(history)) {
    return [];
  }

  const counterByStation = {};

  history.forEach((item) => {
    const station = resolveStationForItem(item);
    const rawNumbers = Array.isArray(item?.numbers) ? item.numbers : [];
    if (!rawNumbers.length) {
      return;
    }

    if (!counterByStation[station]) {
      counterByStation[station] = {};
    }

    rawNumbers.forEach((n) => {
      const cleaned = clean(n);
      if (!cleaned) return;
      const key = cleaned.length >= 2 ? cleaned.slice(-2) : cleaned;
      counterByStation[station][key] =
        (counterByStation[station][key] || 0) + 1;
    });
  });

  return Object.entries(counterByStation)
    .map(([dai, counter]) => {
      const top = Object.entries(counter)
        .map(([number, count]) => ({ number, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, Math.max(1, limit));
      return { dai, top };
    })
    .filter((item) => item.top.length)
    .sort((a, b) => a.dai.localeCompare(b.dai, "vi"));
}

async function saveManualCopy(rawText, stationHint) {
  const safeText = String(rawText || "").slice(0, 6000);
  const ticket = parseManualKQXS(safeText, stationHint);
  const numbers = ticket?.numbers || extractNumbers(safeText);
  if (!numbers.length) {
    throw new Error("Không tìm thấy số trong nội dung đã copy");
  }

  const detectedStations = detectStations(safeText, stationHint);
  const splitTickets = ticket
    ? splitTicketByStations(ticket, detectedStations)
    : [];
  const nowIso = new Date().toISOString();
  const safeStationHint =
    stationHint && typeof stationHint === "object" ? stationHint : null;

  const itemsToSave = splitTickets.length
    ? splitTickets.map((splitTicket) => ({
        date: nowIso,
        source: "manual-scan",
        rawText: safeText,
        numbers: splitTicket.numbers,
        station: normalizeStationName(splitTicket.station),
        stationHint: safeStationHint,
        giaiDB: splitTicket.giaiDB || splitTicket.numbers[0] || "",
        giai7: splitTicket.giai7 || [],
        giai8: splitTicket.giai8 || [],
        ticket: splitTicket
      }))
    : [
        {
          date: nowIso,
          source: ticket ? "manual-scan" : "manual-copy",
          rawText: safeText,
          numbers,
          station: normalizeStationName(ticket?.station || parseStation(safeText, stationHint)),
          stationHint: safeStationHint,
          giaiDB: ticket?.giaiDB || numbers[0] || "",
          giai7: ticket?.giai7 || [],
          giai8: ticket?.giai8 || [],
          ticket: ticket || null
        }
      ];

  for (const item of itemsToSave) {
    await saveHistory(item);
  }

  return itemsToSave.length === 1 ? itemsToSave[0] : itemsToSave;
}

async function getHistory(limit = 50) {
  if (!(await fs.pathExists(dataPath))) {
    return [];
  }

  const history = await fs.readJson(dataPath);
  if (!Array.isArray(history)) {
    return [];
  }

  return history.slice(-Math.max(1, limit)).reverse();
}

async function clearHistory() {
  await fs.writeJson(dataPath, [], { spaces: 2 });
  return true;
}

function startAuto() {
  if (cronTask) {
    console.log("Auto Agent đã chạy nền...");
    return;
  }

  const expr = process.env.CRAWL_CRON || "*/5 * * * *";
  const cronExpr = cron.validate(expr) ? expr : "*/5 * * * *";

  cronTask = cron.schedule(cronExpr, () => {
    crawlKQXS().catch((err) => {
      console.error("Lỗi cron crawl:", err.message);
    });
  });

  console.log("Auto Agent đã chạy nền...");
}

module.exports = {
  startAuto,
  crawlKQXS,
  thongKe,
  thongKeTheoDai,
  getHistory,
  saveManualCopy,
  clearHistory
};
