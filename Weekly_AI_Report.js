// ============================================================
// Weekly AI Report — Google Ads + Claude Opus 4.7
// Version: 2.0 — 2026-04-29 (multi-client batch refactor)
// ============================================================
//
// GENEL BAKIŞ
// -----------
// Tek script, tek MCC kopyası. Config Sheet'te ai_enabled = TRUE
// olan tüm müşterileri tek koşumda (zaman bütçesi yeterse) ya da
// birden fazla koşumda (batch + checkpoint) işler.
//
// Pazartesi sabahları otomatik çalışır. Her tetikte:
//   1. Bu hafta için işlenmemiş müşterileri PropertiesService
//      state'inden bulur
//   2. Zaman bütçesi (5 dk) dolana kadar müşterileri sırayla işler
//   3. Her müşteri için: GAQL × 3 dönem → Drive context → Claude API
//      → Master Sheet'in ilgili tab'ına yazım
//   4. State'i güncelleyip çıkar; bir sonraki tetik kaldığı yerden
//      devam eder
//
// VERİ KAYNAKLARI
// ---------------
// 1. Config Sheet (ID sabit, mevcut dashboard'larla ortak)
//    Gerekli kolonlar:
//      - secret_key, client_name, client_account_id
//      - dashboard_spreadsheet_id        (opsiyonel; search term detayı için)
//      - email                           (opsiyonel; hata bildirimi için)
//      - ai_enabled                      (TRUE / FALSE)
//      - ai_drive_folder_id              (her müşteri için ayrı klasör)
//
// 2. Drive klasörü (per client)
//    İçinde:
//      - system_prompt.txt   (zorunlu — müşteriye özel sistem talimatı)
//      - client_brief.md     (önerilen — sektör, ürün, hedefler, ton)
//      - tone_examples.md    (opsiyonel — geçmiş mesaj örnekleri)
//      - başka .txt/.md      (hepsi otomatik okunur, context'e eklenir)
//
// 3. Anthropic API key
//    PropertiesService'te 'ANTHROPIC_API_KEY' anahtarıyla saklanır.
//    Tek seferlik: editor'da setApiKey('sk-ant-...') çalıştır.
//
// 4. AI Master Sheet (script tarafından otomatik üretilir)
//    PropertiesService'te 'AI_MASTER_SHEET_ID' anahtarıyla tutulur.
//    İlk koşumda yoksa otomatik oluşturulur. Manuel override için
//    setMasterSheetId('SHEET_ID') kullanılabilir.
//
// MASTER SHEET YAPISI
// -------------------
// Tab sırası (üstten alta):
//   📊 Özet               cross-client haftalık tarama (rebuild)
//   📋 Geçmiş             tüm müşterilerin haftalık log'u (append)
//   ⚙ Run Log            per-müşteri × per-koşum kayıt (append)
//   <Müşteri 1>           zengin haftalık görünüm (her hafta üzerine yazılır)
//   <Müşteri 2>           ...
//   ...
//
// İLK KURULUM (tek seferlik)
// --------------------------
// 1) MCC'de yeni bir Google Ads Script oluştur, bu kodu yapıştır,
//    "Authorize" akışını tamamla (Drive + Sheets + UrlFetch izni).
//
// 2) Editor'dan SIRAYLA çalıştır (her biri tek seferlik):
//      a) setupConfigSheet()   → Config Sheet'e eksik kolonları ekler
//                                (ai_enabled, ai_drive_folder_id)
//      b) setApiKey('sk-ant-...')  → Anthropic API anahtarını kaydet
//
// 3) Config Sheet'te aktif edilecek her müşteri için:
//      a) ai_enabled hücresine TRUE yaz
//      b) ai_drive_folder_id hücresine Drive klasörünün ID'sini yaz
//         (klasör URL'sinde "folders/" sonrası kısım)
//
// 4) Her aktif müşteri için Drive klasörü hazırla:
//      a) En az system_prompt.txt yerleştir (zorunlu — müşteriye özel)
//      b) İstersen client_brief.md, tone_examples.md ekle
//
// 5) Editor'dan runMainNow() çalıştır → Master Sheet otomatik
//    oluşturulur, ID PropertiesService'e kaydedilir, tüm aktif
//    müşteriler için ilk haftalık rapor üretilir. Logger çıktısında
//    Master Sheet URL'i görünür.
//
// 6) Schedule:
//    Google Ads Scripts UI → Frequency: Hourly.
//    Script kendi içinde "Pazartesi 06:00–12:00" gate'i uygular;
//    pencere dışındaki saatlik tetikler <1 sn'de sessizce çıkar
//    (sıfır API çağrısı, sıfır sheet yazımı, ihmal edilebilir maliyet).
//    Pzt sabahları 6 saatlik pencere içinde 10+ müşteri rahat sığar.
//
// YENİ MÜŞTERİ EKLEME
// -------------------
// 1) Config Sheet'e satır ekle (secret_key, client_account_id,
//    client_name, ai_enabled=TRUE, ai_drive_folder_id).
// 2) Drive klasörünü oluştur, system_prompt.txt yerleştir.
// 3) Bitti — bir sonraki Pazartesi otomatik dahil olur.
//
// MÜŞTERİ ÇIKARMA
// ---------------
// Config Sheet'teki satırı sil veya ai_enabled = FALSE yap.
// Master Sheet'teki tab'ı isteğe bağlı olarak manuel sil.
//
// MANUEL ARAÇLAR (editor'dan tek seferlik çalıştırılır)
// -----------------------------------------------------
//   setupConfigSheet()             Config Sheet'e eksik AI kolonlarını ekle
//   setApiKey('sk-ant-...')        Claude API anahtarı kaydet
//   runMainNow()                   Tüm batch'i şimdi çalıştır (gate bypass)
//   runForClient('SECRET_KEY')     Tek müşteriyi anında işle (batch state'e dokunmaz)
//   clearApiKey()                  API anahtarı sil
//   setMasterSheetId('SHEET_ID')   Master Sheet ID override et
//   getMasterSheetId()             Mevcut master sheet ID logla
//   clearMasterSheetId()           Master Sheet ID sıfırla
//   resetBatchState()              Mevcut hafta state'ini sıfırla (retry için)
//   getBatchStatus()               Mevcut state'i logla
//
// ⚠ Bu açıklama: akışı veya büyük yapıyı değiştiren her kod
//   değişikliğinde güncellenmeli.
// ============================================================

// ── Config Sheet (workspace ortak) ─────────────────────────────
// SETUP: Replace with your own Google Sheet ID. See config_schema.md
// for the required column structure.
var CONFIG_SHEET_ID = '<YOUR_CONFIG_SHEET_ID>';

// ── Anthropic ──────────────────────────────────────────────────
var ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
var ANTHROPIC_VERSION = '2023-06-01';
// Tam model id'sini Anthropic dokümanından doğrulayıp pinleyebilirsin
// (örn. 'claude-opus-4-7-20260101'). Alias da çalışır.
var ANTHROPIC_MODEL   = 'claude-opus-4-7';
var ANTHROPIC_MAX_TOK = 4096;

// ── Çalıştırma sabitleri ───────────────────────────────────────
var TOP_CAMPAIGN_LIMIT  = 10;
var TOP_SEARCH_LIMIT    = 15;

// Batch limitleri
// Google Ads Scripts (Apps Script değil!) tek run için 30 dk hard-limit sağlar.
// 25 dk güvenli tavan; kalan 5 dk state yazımı + log + overhead için buffer.
var TIME_BUDGET_SECONDS = 1500;  // 25 dk
var MAX_CLIENTS_PER_RUN = 30;    // müşteri sayısı büyürse tek run'da bitsin

// Çalışma penceresi (Pazartesi sabah — saatler AŞAĞIDAKİ TZ'ye göre)
// ÖNEMLİ: Google Ads Scripts'te `new Date()` MCC/İstanbul değil; sunucu TZ (ör. GMT-4)
// döner. Gate MUTAKA RUN_GATE_TIMEZONE ile hesaplanmalıdır.
var RUN_GATE_TIMEZONE = 'Europe/Istanbul';

// Haftanın günü — ISO 8601: 1=Pazartesi ... 7=Pazar (Java SimpleDateFormat 'u')
var ALLOWED_ISO_DOW = 1;
var ALLOWED_HOUR_START  = 6;     // dahil (İstanbul saati)
var ALLOWED_HOUR_END    = 12;    // hariç (12:00 İstanbul'a kadar)

// PropertiesService anahtarları
var PROP_API_KEY        = 'ANTHROPIC_API_KEY';
var PROP_MASTER_ID      = 'AI_MASTER_SHEET_ID';
var PROP_BATCH_STATE    = 'BATCH_STATE_v1';

// Sabit tab adları (master sheet)
var TAB_OZET    = 'Özet';
var TAB_GECMIS  = 'Geçmiş';
var TAB_RUNLOG  = 'Run Log';

// Config Sheet log tab'ı (workspace rule gereği)
var CONFIG_LOG_TAB = 'Run Log';
var SCRIPT_NAME    = 'Weekly AI Report';

// ── Renk paleti (mevcut dashboard ile uyumlu) ──────────────────
var COLORS = {
  banner:     '#F9A825',
  bannerText: '#FFFFFF',
  sectionHdr: '#FFE082',
  good:       '#E8F5E9',
  goodHdr:    '#43A047',
  bad:        '#FFF3E0',
  badHdr:     '#FB8C00',
  alert:      '#FFEBEE',
  alertHdr:   '#C62828',
  message:    '#F5F5F5',
  messageHdr: '#607D8B',
  metricsBg:  '#FFFDE7',
  rowOdd:     '#FFFDE7',
  rowEven:    '#FFFFFF',
  posDelta:   '#C8E6C9',
  negDelta:   '#FFCDD2',
  neuDelta:   '#FFFFFF',
};

// Para birimi runtime state — her client iterasyonunda reset edilir
var CONFIG = { currency: 'USD', currencySymbol: '$', clientName: '', clientAccountId: '' };

// ============================================================
// ENTRY POINTS
// ============================================================
// Scheduled (saatlik tetik) — gate Pazartesi 06–12 İstanbul (RUN_GATE_TIMEZONE).
// TEST MODU: BYPASS_GATE = true veya aşağıdaki main() içine geçici olarak yalnızca runMainNow(); yaz.
// Production'da main() her zaman runBatch_ çağıran blok olmalı; testten sonra geri al.
var BYPASS_GATE = false;

function main() {
  // Her koşumda Config Run Log'a bir iz bırak (gate reddetse bile).
  // MCC UI'ında script logları bulmak zor; bu yöntem her hourly koşumun
  // gerçekten çalışıp çalışmadığını Config Sheet'ten görmemizi sağlar.
  var now  = new Date();
  var gateParts = getGateTimeParts_(now);
  var tzDiag =
    'IST DOWiso=' + gateParts.dowIso + ' HOUR=' + gateParts.hour
    + ' | sunucu ts=' + now.toString()
    + ' | gateTZ=' + RUN_GATE_TIMEZONE;
  Logger.log('DIAG: ' + tzDiag);

  if (!BYPASS_GATE && !shouldRunNow_(now)) {
    var gateMsg = 'GATE REDDI — ' + RUN_GATE_TIMEZONE + ' Paz 06–12 dışında. ' + tzDiag;
    Logger.log(gateMsg);
    try { appendConfigRunLog_(gateMsg); } catch (e) {}
    return;
  }
  if (BYPASS_GATE) Logger.log('⚠ BYPASS_GATE aktif — test modu; production için false yap.');
  try {
    appendConfigRunLog_('GATE OK — batch başlatılıyor. ' + tzDiag);
  } catch (e) {}
  runBatch_(/*isScheduled*/ !BYPASS_GATE);
}

// Editor'dan manuel: gün/saat gate'ini ve config log'unu bypass eder.
// İlk kurulumda + ad-hoc test için kullan.
function runMainNow() {
  Logger.log('Manuel batch koşumu başlatılıyor (gate bypass).');
  runBatch_(/*isScheduled*/ false);
}

// Test için: state'i sıfırlar ve batch'i hemen çalıştırır.
// Hatalı müşterileri yeniden denetmek isterken kullan.
function resetAndRun() {
  resetBatchState();
  Logger.log('State sıfırlandı; batch yeniden başlatılıyor.');
  runBatch_(/*isScheduled*/ false);
}

// ============================================================
// BATCH DRIVER
// ============================================================
function runBatch_(isScheduled) {
  var execStart = Date.now();
  Logger.log('=== Weekly AI Report (batch) ===');

  // Tarih aralıkları (tüm müşteriler için ortak)
  var ranges = getWeeklyDateRanges();
  Logger.log('Hafta: ' + ranges.current.label);

  // Master sheet (yoksa oluştur)
  var ss;
  try {
    ss = getOrCreateMasterSheet();
    ensureMasterTabs(ss, ranges);
  } catch (e) {
    var msErr = 'HATA: Master Sheet hazırlanamadı: ' + e.message;
    Logger.log(msErr);
    try { appendConfigRunLog_(msErr); } catch (e2) {}
    return;
  }

  // Tüm aktif müşteriler
  var allClients = getAllAiEnabledClients();
  if (!allClients.length) {
    var noClientMsg = 'Hiç ai_enabled=TRUE müşteri yok; çıkılıyor.';
    Logger.log(noClientMsg);
    try { appendConfigRunLog_(noClientMsg); } catch (e) {}
    return;
  }
  Logger.log('Aktif müşteri sayısı: ' + allClients.length);

  // Batch state oku; hafta değiştiyse sıfırla
  var thisWeekKey = ranges.current.startDate; // YYYY-MM-DD (Pzt)
  var state = loadBatchState_();
  if (state.weekStart !== thisWeekKey) {
    state = { weekStart: thisWeekKey, processedKeys: [], startedAt: nowIso_(), completed: false };
    saveBatchState_(state);
    // Yeni hafta → Özet tab'ını sıfırla
    rebuildOzetHeader_(ss, ranges);
    Logger.log('Yeni hafta tespit edildi; state sıfırlandı.');
  }

  // Bekleyen müşteriler = aktif liste − bu hafta zaten işlenenler
  // (Hafta içinde yeni müşteri eklenirse otomatik yakalanır.)
  var processedSet = {};
  for (var i = 0; i < state.processedKeys.length; i++) processedSet[state.processedKeys[i]] = true;
  var pending = allClients.filter(function(c) { return !processedSet[c.secretKey]; });

  if (!pending.length) {
    var noPendMsg = 'Bekleyen müşteri yok; hafta tamamlandı (' +
      state.processedKeys.length + '/' + allClients.length + ') — ' + ranges.current.label;
    if (!state.completed) {
      state.completed = true;
      saveBatchState_(state);
      if (isScheduled) {
        try { appendConfigRunLog_('Hafta tamamlandı: ' + ranges.current.label + ' — toplam ' + allClients.length + ' müşteri.'); } catch (e) {}
      }
    } else if (isScheduled) {
      // Hafta zaten tamamlanmış; yine de her hourly iz bıraksın ki sessiz kalmayalım.
      try { appendConfigRunLog_(noPendMsg); } catch (e) {}
    }
    Logger.log(noPendMsg);
    return;
  }
  Logger.log('Bekleyen müşteri: ' + pending.length);

  // Sırayla işle, zaman bütçesi dolduğunda bırak
  var processedThisRun = 0;
  var successThisRun   = 0;
  var failedThisRun    = [];

  for (var k = 0; k < pending.length; k++) {
    if (processedThisRun >= MAX_CLIENTS_PER_RUN) {
      Logger.log('Run-bazlı müşteri tavanına ulaşıldı (' + MAX_CLIENTS_PER_RUN + '); çıkılıyor.');
      break;
    }
    var elapsed = (Date.now() - execStart) / 1000;
    if (elapsed > TIME_BUDGET_SECONDS) {
      Logger.log('Zaman bütçesi doldu (' + Math.round(elapsed) + 's); kalan müşteriler sonraki tetiğe.');
      break;
    }

    var client = pending[k];
    Logger.log('--- [' + (k + 1) + '/' + pending.length + '] ' + client.clientName + ' (' + client.secretKey + ') ---');

    var clientStart = Date.now();
    var status = 'OK';
    var note   = '';
    try {
      processClient_(client, ss, ranges);
      successThisRun++;
    } catch (e) {
      status = 'ERROR';
      note   = (e && e.message) ? e.message : String(e);
      failedThisRun.push(client.clientName + ': ' + note);
      Logger.log('HATA (' + client.clientName + '): ' + note);
      try { notifyOnFailure_(client, note); } catch (e2) {}
    }

    var durSec = Math.round((Date.now() - clientStart) / 1000);
    try {
      appendMasterRunLog_(ss, client, status, durSec, note);
    } catch (e3) {
      Logger.log('UYARI: Run Log yazılamadı: ' + e3.message);
    }

    // Hata da olsa state'e ekle (sonsuz retry'a karşı). Manuel
    // resetBatchState() ile yeniden denenebilir.
    state.processedKeys.push(client.secretKey);
    state.lastRunAt = nowIso_();
    saveBatchState_(state);
    processedThisRun++;
  }

  // Tüm müşteriler bittiyse "completed" işaretle
  var stillPending = allClients.length - state.processedKeys.length;
  if (stillPending <= 0) {
    state.completed = true;
    saveBatchState_(state);
  }

  var summary = ''
    + 'Run özeti — bu koşum: ' + processedThisRun + ' müşteri | başarılı: ' + successThisRun
    + ' | hata: ' + failedThisRun.length
    + ' | hafta toplam: ' + state.processedKeys.length + '/' + allClients.length;
  if (failedThisRun.length) summary += ' | hatalar: ' + failedThisRun.join(' || ');
  Logger.log(summary);

  // Workspace rule: yalnızca scheduled koşumlar config sheet'e log yazar
  if (isScheduled) {
    appendConfigRunLog_(summary);
  }

  Logger.log('=== Tamamlandı ===');
  Logger.log('Master Sheet: ' + ss.getUrl());
}

/**
 * Gate zamanı — RUN_GATE_TIMEZONE (İstanbul). Ads sunucusunun Date.getHours() ile karıştırma.
 * @param {Date} d
 * @return {{hour:number, dowIso:number}}
 */
function getGateTimeParts_(d) {
  var tz = RUN_GATE_TIMEZONE;
  var hour = parseInt(Utilities.formatDate(d, tz, 'HH'), 10);
  var dowIso = parseInt(Utilities.formatDate(d, tz, 'u'), 10);
  return { hour: hour, dowIso: dowIso };
}

// Pazartesi 06:00–11:59 (İstanbul), RUN_GATE_TIMEZONE'a göre
function shouldRunNow_(d) {
  var p = getGateTimeParts_(d);
  if (p.dowIso !== ALLOWED_ISO_DOW) return false;
  if (p.hour < ALLOWED_HOUR_START || p.hour >= ALLOWED_HOUR_END) return false;
  return true;
}

// ============================================================
// PER-CLIENT PROCESSOR
// ============================================================
function processClient_(client, ss, ranges) {
  // Global state reset (önceki client'tan sızma olmasın)
  CONFIG.currency        = 'USD';
  CONFIG.currencySymbol  = '$';
  CONFIG.clientName      = client.clientName;
  CONFIG.clientAccountId = client.accountId;

  // Drive klasörü zorunlu
  if (!client.aiDriveFolderId) {
    throw new Error('ai_drive_folder_id boş — ' + client.clientName);
  }

  // MCC altında ilgili hesaba geç
  if (typeof AdsManagerApp !== 'undefined' && client.accountId) {
    var iter = AdsManagerApp.accounts().withIds([client.accountId]).get();
    if (!iter.hasNext()) {
      throw new Error('MCC hesabı bulunamadı: ' + client.accountId);
    }
    AdsManagerApp.select(iter.next());
  }

  // Para birimi
  detectCurrency();

  // Hesap metrikleri × 3
  var mCur  = fetchAccountMetrics(ranges.current.startDate,    ranges.current.endDate);
  var mLast = fetchAccountMetrics(ranges.lastWeek.startDate,   ranges.lastWeek.endDate);
  var mBase = fetchAccountMetrics(ranges.baseline4w.startDate, ranges.baseline4w.endDate);
  var mBaseWeekly = scaleBaselineToWeekly(mBase, 7, 28);

  // Top kampanyalar
  var topCampaigns = fetchTopCampaignsForRange(
    ranges.current.startDate, ranges.current.endDate, TOP_CAMPAIGN_LIMIT
  );
  Logger.log('Top kampanya: ' + topCampaigns.length);

  // Search Term detayı (varsa)
  var topSearchTerms = [];
  if (client.dashboardSpreadsheetId) {
    try {
      topSearchTerms = readDashboardSearchTerms(client.dashboardSpreadsheetId, TOP_SEARCH_LIMIT);
      Logger.log('Search Term: ' + topSearchTerms.length);
    } catch (e) {
      Logger.log('UYARI: Dashboard Search Term okunamadı: ' + e.message);
    }
  }

  // Drive context
  var ctx;
  try {
    ctx = loadAIContext(client.aiDriveFolderId);
  } catch (e) {
    throw new Error('Drive klasörüne erişilemedi (ai_drive_folder_id=' + client.aiDriveFolderId + '). ' +
                    'Klasörü script\'i authorize eden Google hesabıyla paylaştığından emin ol. Orijinal hata: ' + e.message);
  }
  if (!ctx.systemPrompt) {
    Logger.log('UYARI: system_prompt.txt yok; default kullanılıyor.');
  }

  // Prompt + Claude
  var promptInputs = {
    clientName:     client.clientName,
    currency:       CONFIG.currency,
    currencySym:    CONFIG.currencySymbol,
    ranges:         ranges,
    metrics:        { current: mCur, lastWeek: mLast, baseline4w: mBase, baselineWeekly: mBaseWeekly },
    topCampaigns:   topCampaigns,
    topSearchTerms: topSearchTerms,
    projectFiles:   ctx.projectFiles,
  };

  var systemMsg = buildSystemPrompt(ctx.systemPrompt);
  var userMsg   = buildUserMessage(promptInputs);
  var ai        = callClaude(systemMsg, userMsg);

  // Master Sheet yazımı
  writeClientWeeklyTab_(ss, client, ranges, promptInputs.metrics, topCampaigns, ai);
  upsertOzetRow_(ss, client, ranges, promptInputs.metrics, ai);
  appendGecmisRow_(ss, client, ranges, promptInputs.metrics, ai);
}

// ============================================================
// CONFIG SHEET — TÜM MÜŞTERİLER
// ============================================================
function getAllAiEnabledClients() {
  var ss;
  try {
    ss = SpreadsheetApp.openById(CONFIG_SHEET_ID);
  } catch (e) {
    Logger.log('HATA: Config Sheet açılamadı: ' + e.message);
    return [];
  }

  var sheet   = ss.getSheets()[0];
  var data    = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var headers = data[0];

  function col(name) {
    for (var c = 0; c < headers.length; c++) {
      if (String(headers[c]).trim().toLowerCase() === name.toLowerCase()) return c;
    }
    return -1;
  }

  var iKey       = col('secret_key');
  var iName      = col('client_name');
  var iAccountId = col('client_account_id');
  var iEmail     = col('email');
  var iDashId    = col('dashboard_spreadsheet_id');
  var iAiEnabled = col('ai_enabled');
  var iAiFolder  = col('ai_drive_folder_id');

  if (iKey === -1 || iAccountId === -1 || iAiEnabled === -1 || iAiFolder === -1) {
    Logger.log('HATA: Config Sheet\'te zorunlu kolon eksik. Gereken: secret_key, client_account_id, ai_enabled, ai_drive_folder_id');
    return [];
  }

  var out = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var enabled = String(row[iAiEnabled]).trim().toUpperCase() === 'TRUE';
    if (!enabled) continue;
    var key = String(row[iKey]).trim();
    if (!key) continue;
    out.push({
      rowIndex:               i + 1,
      secretKey:              key,
      clientName:             String(iName     > -1 ? row[iName]     : key).trim(),
      accountId:              String(row[iAccountId]).trim().replace(/-/g, ''),
      emailRecipient:         String(iEmail    > -1 ? row[iEmail]    : '').trim(),
      dashboardSpreadsheetId: String(iDashId   > -1 ? row[iDashId]   : '').trim(),
      aiDriveFolderId:        String(row[iAiFolder]).trim(),
    });
  }
  return out;
}

function findClientBySecretKey_(key) {
  var all = getAllAiEnabledClients();
  for (var i = 0; i < all.length; i++) {
    if (all[i].secretKey === key) return all[i];
  }
  return null;
}

// ============================================================
// BATCH STATE — PROPERTIES SERVICE
// ============================================================
function loadBatchState_() {
  var raw = PropertiesService.getScriptProperties().getProperty(PROP_BATCH_STATE);
  if (!raw) return { weekStart: '', processedKeys: [], completed: false };
  try {
    var s = JSON.parse(raw);
    if (!s.processedKeys) s.processedKeys = [];
    return s;
  } catch (e) {
    Logger.log('UYARI: Batch state parse edilemedi, sıfırlanıyor.');
    return { weekStart: '', processedKeys: [], completed: false };
  }
}

function saveBatchState_(state) {
  PropertiesService.getScriptProperties().setProperty(PROP_BATCH_STATE, JSON.stringify(state));
}

function resetBatchState() {
  PropertiesService.getScriptProperties().deleteProperty(PROP_BATCH_STATE);
  Logger.log('Batch state sıfırlandı. Bir sonraki main() koşumu hafta sıfırdan başlar.');
}

function getBatchStatus() {
  var s = loadBatchState_();
  Logger.log('Batch state:\n' + JSON.stringify(s, null, 2));
  return s;
}

// ============================================================
// MASTER SHEET — UPSERT / TABLAR
// ============================================================
function getOrCreateMasterSheet() {
  var props = PropertiesService.getScriptProperties();
  var id    = props.getProperty(PROP_MASTER_ID);
  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (e) {
      Logger.log('UYARI: Mevcut Master Sheet açılamadı; yenisi oluşturulacak: ' + e.message);
    }
  }
  var title = 'Weekly AI Reports — Master';
  var ss    = SpreadsheetApp.create(title);
  props.setProperty(PROP_MASTER_ID, ss.getId());
  Logger.log('Yeni Master Sheet oluşturuldu: ' + title + ' — ' + ss.getUrl());
  return ss;
}

function setMasterSheetId(id) {
  PropertiesService.getScriptProperties().setProperty(PROP_MASTER_ID, id);
  Logger.log('Master Sheet ID kaydedildi: ' + id);
}

function getMasterSheetId() {
  var id = PropertiesService.getScriptProperties().getProperty(PROP_MASTER_ID);
  Logger.log('Master Sheet ID: ' + (id || '(yok)'));
  return id;
}

function clearMasterSheetId() {
  PropertiesService.getScriptProperties().deleteProperty(PROP_MASTER_ID);
  Logger.log('Master Sheet ID silindi.');
}

// İlk 3 sabit tab'ı garanti et (Özet, Geçmiş, Run Log) ve sırasını korumak için pozisyonla
function ensureMasterTabs(ss, ranges) {
  // Sheet1 vb. default tab varsa ve master tab'larımız yoksa onu sileceğiz
  var defaults = ss.getSheets();
  var hasOzet  = !!ss.getSheetByName(TAB_OZET);
  var hasGec   = !!ss.getSheetByName(TAB_GECMIS);
  var hasLog   = !!ss.getSheetByName(TAB_RUNLOG);

  if (!hasOzet) {
    var ozet = ss.insertSheet(TAB_OZET, 0);
    ozet.setTabColor(COLORS.banner);
    rebuildOzetHeader_(ss, ranges, ozet);
  } else {
    // Varsa ilk pozisyona taşı
    var s = ss.getSheetByName(TAB_OZET);
    ss.setActiveSheet(s);
    ss.moveActiveSheet(1);
  }

  if (!hasGec) {
    var gec = ss.insertSheet(TAB_GECMIS, 1);
    gec.setTabColor(COLORS.messageHdr);
    initGecmisHeader_(gec);
  } else {
    var s2 = ss.getSheetByName(TAB_GECMIS);
    ss.setActiveSheet(s2);
    ss.moveActiveSheet(2);
  }

  if (!hasLog) {
    var lg = ss.insertSheet(TAB_RUNLOG, 2);
    lg.setTabColor('#9E9E9E');
    initRunLogHeader_(lg);
  } else {
    var s3 = ss.getSheetByName(TAB_RUNLOG);
    ss.setActiveSheet(s3);
    ss.moveActiveSheet(3);
  }

  // Default Sheet1 vb. boş tab'ı temizle (master tab'larımız varsa)
  for (var i = 0; i < defaults.length; i++) {
    var name = defaults[i].getName();
    if (name === TAB_OZET || name === TAB_GECMIS || name === TAB_RUNLOG) continue;
    if (name === 'Sheet1' && defaults[i].getLastRow() <= 1) {
      try { ss.deleteSheet(defaults[i]); } catch (e) {}
    }
  }
}

// Sheet adı sanitizasyonu (Google Sheets kısıtları + uzunluk)
function sanitizeTabName_(name) {
  var s = String(name || 'Müşteri').replace(/[\[\]\:\*\?\/\\]/g, '-').trim();
  if (s.length > 90) s = s.slice(0, 90);
  if (!s) s = 'Müşteri';
  return s;
}

function getOrCreateClientTab_(ss, clientName) {
  var name  = sanitizeTabName_(clientName);
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.setTabColor('#FFB74D');
  }
  return sheet;
}

// ============================================================
// MASTER SHEET — ÖZET TAB
// ============================================================
function rebuildOzetHeader_(ss, ranges, sheetOpt) {
  var sheet = sheetOpt || ss.getSheetByName(TAB_OZET) || ss.insertSheet(TAB_OZET, 0);
  try { sheet.getFilter().remove(); } catch (e) {}
  sheet.clearContents();
  sheet.clearFormats();

  // Banner
  sheet.getRange(1, 1, 1, 9).merge()
    .setValue('HAFTALIK ÖZET — ' + ranges.current.startDate + ' → ' + ranges.current.endDate)
    .setBackground(COLORS.banner)
    .setFontColor(COLORS.bannerText)
    .setFontWeight('bold')
    .setFontSize(13)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(1, 36);

  var headers = ['Müşteri', 'Cost', 'WoW Cost%', 'Conv', 'WoW Conv%', 'ROAS', 'WoW ROAS%', 'Red Alert', 'İlk Aksiyon'];
  sheet.getRange(2, 1, 1, headers.length)
    .setValues([headers])
    .setBackground(COLORS.sectionHdr)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(2, 28);
  sheet.setFrozenRows(2);

  sheet.setColumnWidth(1, 200);
  for (var c = 2; c <= 8; c++) sheet.setColumnWidth(c, 110);
  sheet.setColumnWidth(9, 360);
}

function upsertOzetRow_(ss, client, ranges, metrics, ai) {
  var sheet = ss.getSheetByName(TAB_OZET);
  if (!sheet) {
    rebuildOzetHeader_(ss, ranges);
    sheet = ss.getSheetByName(TAB_OZET);
  } else {
    // Banner/header manuel silinmiş olabilir; row 2'de 'Müşteri' etiketi yoksa yeniden inşa et.
    // rebuildOzetHeader_ mevcut sheet'i clear edip sıfırdan kurar — müşteri satırları da silinir,
    // ama zaten her koşumda her müşteri için upsert çağrıldığı için veri kaybı olmaz (aynı koşumda yeniden yazılır).
    var hdrCell = String(sheet.getRange(2, 1).getValue()).trim();
    if (hdrCell !== 'Müşteri') {
      rebuildOzetHeader_(ss, ranges, sheet);
    }
  }

  var c     = metrics.current;
  var l     = metrics.lastWeek;
  var dCost = pctChange(c.cost,        l.cost);
  var dConv = pctChange(c.conversions, l.conversions);
  var dRoas = pctChange(c.roas,        l.roas);
  var redCount = (ai && ai.red_alerts && ai.red_alerts.length) ? ai.red_alerts.length : 0;
  var firstAct = (ai && ai.action_plan && ai.action_plan.length) ? ai.action_plan[0] : '';

  // Infinity / NaN → boş string; hücrenin format'ı uygulanamıyor
  function safePct(v) { return (v === Infinity || v === -Infinity || isNaN(v)) ? '' : v; }

  var rowData = [
    client.clientName,
    Math.round(c.cost * 100) / 100,              // numeric; para birimi format'ı aşağıda uygulanır
    safePct(dCost),                              // numeric decimal; % format'ı aşağıda
    Math.round(c.conversions * 100) / 100,
    safePct(dConv),
    Math.round(c.roas * 100) / 100,
    safePct(dRoas),
    redCount,
    firstAct,
  ];

  // Var olan satırı bul (sütun 1 = client name)
  var lastRow = sheet.getLastRow();
  var targetRow = -1;
  if (lastRow > 2) {
    var names = sheet.getRange(3, 1, lastRow - 2, 1).getValues();
    for (var i = 0; i < names.length; i++) {
      if (String(names[i][0]).trim() === client.clientName) {
        targetRow = 3 + i;
        break;
      }
    }
  }
  if (targetRow === -1) targetRow = lastRow + 1 < 3 ? 3 : lastRow + 1;

  sheet.getRange(targetRow, 1, 1, rowData.length)
    .setValues([rowData])
    .setFontColor('#212121')
    .setFontWeight('normal')
    .setFontSize(10)
    .setVerticalAlignment('middle');
  sheet.getRange(targetRow, 1).setHorizontalAlignment('left');
  sheet.getRange(targetRow, 2, 1, 7).setHorizontalAlignment('right');
  sheet.getRange(targetRow, 9).setHorizontalAlignment('left').setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);

  // Number format'lar (tutarlı görünüm + xlsx export için)
  var sym = CONFIG.currencySymbol;
  sheet.getRange(targetRow, 2).setNumberFormat('"' + sym + '"#,##0.00');   // Cost
  sheet.getRange(targetRow, 3).setNumberFormat('+0.0%;-0.0%;0.0%');        // WoW Cost%
  sheet.getRange(targetRow, 4).setNumberFormat('#,##0.00');                // Conv
  sheet.getRange(targetRow, 5).setNumberFormat('+0.0%;-0.0%;0.0%');        // WoW Conv%
  sheet.getRange(targetRow, 6).setNumberFormat('#,##0.00');                // ROAS
  sheet.getRange(targetRow, 7).setNumberFormat('+0.0%;-0.0%;0.0%');        // WoW ROAS%
  sheet.getRange(targetRow, 8).setNumberFormat('0');                       // Red Alert count

  // Δ% renkleri
  paintDeltaCell(sheet, targetRow, 3, dCost, /*betterUp*/ false);
  paintDeltaCell(sheet, targetRow, 5, dConv, /*betterUp*/ true);
  paintDeltaCell(sheet, targetRow, 7, dRoas, /*betterUp*/ true);

  // Red alert vurgusu
  if (redCount > 0) {
    sheet.getRange(targetRow, 8).setBackground(COLORS.alert).setFontColor(COLORS.alertHdr).setFontWeight('bold');
  }

  sheet.setRowHeight(targetRow, 32);
}

// ============================================================
// MASTER SHEET — GEÇMİŞ TAB
// ============================================================
function initGecmisHeader_(sheet) {
  var headers = [
    'Rapor Tarihi', 'Müşteri', 'Hafta',
    'Cost', 'Conv', 'ROAS',
    'WoW Cost%', 'WoW Conv%', 'WoW ROAS%',
    'Red Alert', 'İlk Aksiyon', 'Değerlendirme Özeti', 'Müşteri Mesajı', 'Tam JSON',
  ];
  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setBackground(COLORS.banner)
    .setFontColor(COLORS.bannerText)
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 100);
  sheet.setColumnWidth(2, 150);
  sheet.setColumnWidth(3, 200);
  for (var c = 4; c <= 10; c++) sheet.setColumnWidth(c, 100);
  sheet.setColumnWidth(11, 280);
  sheet.setColumnWidth(12, 360);
  sheet.setColumnWidth(13, 420);
  sheet.setColumnWidth(14, 280);
}

function appendGecmisRow_(ss, client, ranges, metrics, ai) {
  var sheet = ss.getSheetByName(TAB_GECMIS);
  if (!sheet) {
    sheet = ss.insertSheet(TAB_GECMIS);
    initGecmisHeader_(sheet);
  } else {
    // Header manuel silinmiş olabilir. Silindiyse alttaki data yukarı kaymıştır;
    // data'yı korumak için önce yeni bir row 1 insert edip sonra header yazıyoruz.
    var hdrFirst = String(sheet.getRange(1, 1).getValue()).trim();
    if (hdrFirst !== 'Rapor Tarihi') {
      sheet.insertRowBefore(1);
      initGecmisHeader_(sheet);
    }
  }

  var c     = metrics.current;
  var l     = metrics.lastWeek;
  var dCost = pctChange(c.cost,        l.cost);
  var dConv = pctChange(c.conversions, l.conversions);
  var dRoas = pctChange(c.roas,        l.roas);

  var redCount  = (ai && ai.red_alerts && ai.red_alerts.length) ? ai.red_alerts.length : 0;
  var firstAct  = (ai && ai.action_plan && ai.action_plan.length) ? ai.action_plan[0] : '';
  var evalText  = ai && ai.evaluation_report ? ai.evaluation_report : '';
  var evalShort = evalText.length > 240 ? evalText.slice(0, 237) + '...' : evalText;
  var custMsg   = ai && ai.customer_message ? ai.customer_message : '';
  var fullJson  = '';
  try {
    fullJson = JSON.stringify(ai);
    if (fullJson.length > 45000) fullJson = fullJson.slice(0, 44990) + '...[truncated]';
  } catch (e) { fullJson = ''; }

  function safePct(v) { return (v === Infinity || v === -Infinity || isNaN(v)) ? '' : v; }

  var newRow = [
    new Date(),                                         // Rapor Tarihi (Date obj)
    client.clientName,
    ranges.current.startDate + ' → ' + ranges.current.endDate,
    Math.round(c.cost * 100) / 100,                     // Cost
    Math.round(c.conversions * 100) / 100,              // Conv
    Math.round(c.roas * 100) / 100,                     // ROAS
    safePct(dCost),                                     // WoW Cost% (decimal)
    safePct(dConv),                                     // WoW Conv% (decimal)
    safePct(dRoas),                                     // WoW ROAS% (decimal)
    redCount,
    firstAct,
    evalShort,
    custMsg,
    fullJson,
  ];

  // Yeni satırı header'ın hemen altına ekle (en yeni en üstte)
  sheet.insertRowAfter(1);
  // insertRowAfter, header'dan (beyaz font + bold) formatlamayı miras alıyor;
  // data satırı için explicit olarak sıfırla. Uzun metinler CLIP ile tek satıra sığar,
  // tam içerik hücreye tıklanınca formula bar'da görünür.
  sheet.getRange(2, 1, 1, newRow.length)
    .setValues([newRow])
    .setFontColor('#212121')
    .setFontWeight('normal')
    .setFontSize(10)
    .setBackground(COLORS.rowOdd)
    .setVerticalAlignment('middle')
    .setHorizontalAlignment('left')
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);

  // Number format'lar (tutarlı görünüm + xlsx export için)
  var sym = CONFIG.currencySymbol;
  sheet.getRange(2, 1).setNumberFormat('yyyy-mm-dd');              // Rapor Tarihi
  sheet.getRange(2, 4).setNumberFormat('"' + sym + '"#,##0.00');   // Cost
  sheet.getRange(2, 5).setNumberFormat('#,##0.00');                // Conv
  sheet.getRange(2, 6).setNumberFormat('#,##0.00');                // ROAS
  sheet.getRange(2, 7).setNumberFormat('+0.0%;-0.0%;0.0%');        // WoW Cost%
  sheet.getRange(2, 8).setNumberFormat('+0.0%;-0.0%;0.0%');        // WoW Conv%
  sheet.getRange(2, 9).setNumberFormat('+0.0%;-0.0%;0.0%');        // WoW ROAS%
  sheet.getRange(2, 10).setNumberFormat('0');                      // Red Alert

  paintDeltaCell(sheet, 2, 7, dCost, /*betterUp*/ false);
  paintDeltaCell(sheet, 2, 8, dConv, /*betterUp*/ true);
  paintDeltaCell(sheet, 2, 9, dRoas, /*betterUp*/ true);
  if (redCount > 0) {
    sheet.getRange(2, 10).setBackground(COLORS.alert).setFontColor(COLORS.alertHdr).setFontWeight('bold');
  }
  // Kompakt tek-satır yükseklik; uzun metinler tıklanınca formula bar'da görünür
  sheet.setRowHeight(2, 28);
}

// ============================================================
// MASTER SHEET — RUN LOG TAB
// ============================================================
function initRunLogHeader_(sheet) {
  var headers = ['Timestamp', 'Script', 'Müşteri', 'Status', 'Süre (s)', 'Not'];
  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setBackground(COLORS.banner)
    .setFontColor(COLORS.bannerText)
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 160);
  sheet.setColumnWidth(2, 160);
  sheet.setColumnWidth(3, 180);
  sheet.setColumnWidth(4, 80);
  sheet.setColumnWidth(5, 80);
  sheet.setColumnWidth(6, 480);
}

function appendMasterRunLog_(ss, client, status, durationSec, note) {
  var sheet = ss.getSheetByName(TAB_RUNLOG);
  if (!sheet) {
    sheet = ss.insertSheet(TAB_RUNLOG);
    initRunLogHeader_(sheet);
  }
  var row = [nowIso_(), SCRIPT_NAME, client.clientName, status, durationSec, note || ''];
  sheet.insertRowAfter(1);
  sheet.getRange(2, 1, 1, row.length)
    .setValues([row])
    .setVerticalAlignment('top')
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);
  if (status === 'ERROR') {
    sheet.getRange(2, 4).setBackground(COLORS.alert).setFontColor(COLORS.alertHdr).setFontWeight('bold');
  }
}

// ============================================================
// CONFIG SHEET — RUN LOG (workspace rule)
// ============================================================
function appendConfigRunLog_(summary) {
  try {
    var ss    = SpreadsheetApp.openById(CONFIG_SHEET_ID);
    var sheet = ss.getSheetByName(CONFIG_LOG_TAB);
    if (!sheet) {
      sheet = ss.insertSheet(CONFIG_LOG_TAB);
      sheet.getRange(1, 1, 1, 3).setValues([['Timestamp', 'Script', 'Özet']])
        .setBackground(COLORS.banner)
        .setFontColor(COLORS.bannerText)
        .setFontWeight('bold')
        .setHorizontalAlignment('center');
      sheet.setFrozenRows(1);
      sheet.setColumnWidth(1, 160);
      sheet.setColumnWidth(2, 160);
      sheet.setColumnWidth(3, 600);
    }
    sheet.insertRowAfter(1);
    sheet.getRange(2, 1, 1, 3)
      .setValues([[nowIso_(), SCRIPT_NAME, summary]])
      .setVerticalAlignment('top')
      .setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);
  } catch (e) {
    Logger.log('UYARI: Config Sheet Run Log yazılamadı: ' + e.message);
  }
}

// ============================================================
// PER-CLIENT — ZENGİN HAFTALIK TAB (master sheet içinde)
// ============================================================
function writeClientWeeklyTab_(ss, client, ranges, metrics, topCampaigns, ai) {
  var sheet = getOrCreateClientTab_(ss, client.clientName);

  try { sheet.getFilter().remove(); } catch (e) {}
  sheet.clearContents();
  sheet.clearFormats();

  var COL_COUNT = 7;
  var row = 1;

  // Banner
  sheet.getRange(row, 1, 1, COL_COUNT).merge()
    .setValue('WEEKLY AI REPORT — ' + client.clientName + ' — ' + ranges.current.label)
    .setBackground(COLORS.banner)
    .setFontColor(COLORS.bannerText)
    .setFontWeight('bold')
    .setFontSize(13)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  sheet.setRowHeight(row, 36);
  row++;

  // Boş satır (nefes)
  row++;

  // Bölüm 1: Hafta Karşılaştırması (metrik tablosu)
  row = writeMetricsBlock_(sheet, row, COL_COUNT, ranges, metrics);
  row++;

  // AI üretimi parse hatasıysa: ham metni göster ve uyar
  if (ai && ai._parseError) {
    row = writeSection_(sheet, row, COL_COUNT,
      'UYARI — JSON Parse Edilemedi',
      'AI yanıtı yapısal değildi; ham metin aşağıdadır:\n\n' + (ai._raw || ''),
      COLORS.alert, COLORS.alertHdr);
    return;
  }

  row = writeSection_(sheet, row, COL_COUNT,
    'Değerlendirme Raporu',
    ai.evaluation_report || '(boş)',
    '#FFFFFF', COLORS.sectionHdr);
  row++;

  row = writeListSection_(sheet, row, COL_COUNT,
    'Aksiyon Planı', ai.action_plan, /*numbered*/ true,
    '#FFFFFF', COLORS.sectionHdr);
  row++;

  row = writeListSection_(sheet, row, COL_COUNT,
    'İyi Giden Şeyler', ai.good_things, false,
    COLORS.good, COLORS.goodHdr);
  row++;

  row = writeListSection_(sheet, row, COL_COUNT,
    'Kötü Giden Şeyler', ai.bad_things, false,
    COLORS.bad, COLORS.badHdr);
  row++;

  var redAlerts = (ai.red_alerts && ai.red_alerts.length) ? ai.red_alerts : ['Bu hafta kritik bir alarm yok.'];
  row = writeListSection_(sheet, row, COL_COUNT,
    'Kırmızı Alarm', redAlerts, false,
    COLORS.alert, COLORS.alertHdr);
  row++;

  row = writeSection_(sheet, row, COL_COUNT,
    'Müşteri Mesajı (kopyala / yapıştır)',
    ai.customer_message || '(boş)',
    COLORS.message, COLORS.messageHdr,
    /*monospace*/ true);
  row++;

  if (topCampaigns && topCampaigns.length) {
    row = writeTopCampaignsBlock_(sheet, row, COL_COUNT, topCampaigns);
    row++;
  }

  sheet.setColumnWidth(1, 220);
  for (var cc = 2; cc <= COL_COUNT; cc++) sheet.setColumnWidth(cc, 130);
  sheet.setFrozenRows(1);

  var maxRows = sheet.getMaxRows();
  var maxCols = sheet.getMaxColumns();
  if (maxRows > row + 5)   { try { sheet.deleteRows(row + 5, maxRows - (row + 5)); } catch (e) {} }
  if (maxCols > COL_COUNT) { try { sheet.deleteColumns(COL_COUNT + 1, maxCols - COL_COUNT); } catch (e) {} }
}

// ============================================================
// PARA BİRİMİ
// ============================================================
function detectCurrency() {
  var SYMBOLS = {
    USD: '$', EUR: '€', GBP: '£', TRY: '₺',
    AUD: 'A$', CAD: 'C$', NZD: 'NZ$', CHF: 'Fr',
    JPY: '¥', CNY: '¥', INR: '₹', BRL: 'R$',
    MXN: 'MX$', SEK: 'kr', NOK: 'kr', DKK: 'kr',
    PLN: 'zł', CZK: 'Kč', HUF: 'Ft', RON: 'lei',
    HKD: 'HK$', SGD: 'S$', AED: 'د.إ', SAR: '﷼',
    ZAR: 'R',  THB: '฿',  IDR: 'Rp', PHP: '₱',
  };
  try {
    var code = AdsApp.currentAccount().getCurrencyCode();
    CONFIG.currency       = code;
    CONFIG.currencySymbol = SYMBOLS[code] || (code + ' ');
  } catch (e) {
    Logger.log('Para birimi otomatik algılanamadı, USD kullanılıyor.');
  }
}

// ============================================================
// TARİH ARALIKLARI
// ============================================================
function fmtDate(d) {
  return d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
}

// Pazartesi koşumu varsayımıyla:
//   current    = önceki Pzt → önceki Paz (son tam hafta)
//   lastWeek   = onun bir öncesi (Pzt → Paz)
//   baseline4w = current'tan önceki 28 gün (lastWeek dahil)
function getWeeklyDateRanges() {
  var today = new Date();
  var dow          = today.getDay();
  var daysSinceMon = (dow + 6) % 7;
  var thisMonday   = new Date(today);
  thisMonday.setDate(today.getDate() - daysSinceMon);
  thisMonday.setHours(0, 0, 0, 0);

  var DAY = 86400000;
  var curEnd   = new Date(thisMonday.getTime() - DAY);             // önceki Paz
  var curStart = new Date(thisMonday.getTime() - 7 * DAY);          // önceki Pzt
  var lwEnd    = new Date(curStart.getTime() - DAY);
  var lwStart  = new Date(curStart.getTime() - 7 * DAY);
  var blEnd    = new Date(curStart.getTime() - DAY);
  var blStart  = new Date(curStart.getTime() - 28 * DAY);

  function range(start, end, name) {
    var s = fmtDate(start), e = fmtDate(end);
    return { startDate: s, endDate: e, label: s + ' → ' + e + ' (' + name + ')' };
  }
  return {
    current:    range(curStart, curEnd, 'Bu Hafta'),
    lastWeek:   range(lwStart,  lwEnd,  'Geçen Hafta'),
    baseline4w: range(blStart,  blEnd,  '4-Haftalık Baseline'),
  };
}

// ============================================================
// GAQL — HESAP METRİKLERİ
// ============================================================
function fetchAccountMetrics(startDate, endDate) {
  var q = 'SELECT '
    + 'metrics.impressions, metrics.clicks, metrics.cost_micros, '
    + 'metrics.ctr, metrics.average_cpc, metrics.conversions, '
    + 'metrics.cost_per_conversion, metrics.conversions_from_interactions_rate, '
    + 'metrics.conversions_value, '
    + 'metrics.search_impression_share, '
    + 'metrics.search_budget_lost_impression_share, '
    + 'metrics.search_rank_lost_impression_share '
    + 'FROM customer '
    + "WHERE segments.date BETWEEN '" + startDate + "' AND '" + endDate + "'";

  var empty = {
    cost: 0, impressions: 0, clicks: 0, ctr: 0, avgCpc: 0,
    conversions: 0, cpa: 0, convRate: 0, convValue: 0, roas: 0,
    searchIs: 0, lostIsBudget: 0, lostIsRank: 0,
  };
  try {
    var rows = AdsApp.report(q).rows();
    if (!rows.hasNext()) return empty;
    var r    = rows.next();
    var cost = mic(r['metrics.cost_micros']);
    var conv = pf(r['metrics.conversions']);
    var cv   = pf(r['metrics.conversions_value']);
    return {
      cost:         cost,
      impressions:  pf(r['metrics.impressions']),
      clicks:       pf(r['metrics.clicks']),
      ctr:          pf(r['metrics.ctr']),
      avgCpc:       mic(r['metrics.average_cpc']),
      conversions:  conv,
      cpa:          mic(r['metrics.cost_per_conversion']),
      convRate:     pf(r['metrics.conversions_from_interactions_rate']),
      convValue:    cv,
      roas:         cost > 0 ? cv / cost : 0,
      searchIs:     pf(r['metrics.search_impression_share']),
      lostIsBudget: pf(r['metrics.search_budget_lost_impression_share']),
      lostIsRank:   pf(r['metrics.search_rank_lost_impression_share']),
    };
  } catch (e) {
    Logger.log('fetchAccountMetrics hata (' + startDate + ' → ' + endDate + '): ' + e.message);
    return empty;
  }
}

// Baseline'ı haftalık denkliğe ölçekle (sayım metrikleri için).
// Oran metrikleri (CTR, CPA, ROAS, IS) dönem-bağımsız olduklarından sabit kalır.
function scaleBaselineToWeekly(m, weekDays, baseDays) {
  var f = weekDays / baseDays;
  return {
    cost:         m.cost * f,
    impressions:  m.impressions * f,
    clicks:       m.clicks * f,
    ctr:          m.ctr,
    avgCpc:       m.avgCpc,
    conversions:  m.conversions * f,
    cpa:          m.cpa,
    convRate:     m.convRate,
    convValue:    m.convValue * f,
    roas:         m.roas,
    searchIs:     m.searchIs,
    lostIsBudget: m.lostIsBudget,
    lostIsRank:   m.lostIsRank,
  };
}

function fetchTopCampaignsForRange(startDate, endDate, limit) {
  var q = 'SELECT '
    + 'campaign.name, campaign.advertising_channel_type, '
    + 'metrics.cost_micros, metrics.impressions, metrics.clicks, '
    + 'metrics.conversions, metrics.conversions_value '
    + 'FROM campaign '
    + "WHERE segments.date BETWEEN '" + startDate + "' AND '" + endDate + "' "
    + "AND campaign.status IN ('ENABLED','PAUSED') "
    + 'AND metrics.impressions > 0 '
    + 'ORDER BY metrics.cost_micros DESC '
    + 'LIMIT ' + limit;
  var out = [];
  try {
    var rows = AdsApp.report(q).rows();
    while (rows.hasNext()) {
      var r    = rows.next();
      var cost = mic(r['metrics.cost_micros']);
      var conv = pf(r['metrics.conversions']);
      var cv   = pf(r['metrics.conversions_value']);
      out.push({
        name:        r['campaign.name'],
        type:        r['campaign.advertising_channel_type'],
        cost:        cost,
        impressions: pf(r['metrics.impressions']),
        clicks:      pf(r['metrics.clicks']),
        conversions: conv,
        convValue:   cv,
        cpa:         conv > 0 ? cost / conv : 0,
        roas:        cost > 0 ? cv / cost : 0,
      });
    }
  } catch (e) {
    Logger.log('fetchTopCampaignsForRange hata: ' + e.message);
  }
  return out;
}

// ============================================================
// DASHBOARD SHEET — DEFANSİF OKUMA
// ============================================================
function readDashboardSearchTerms(spreadsheetId, limit) {
  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sheets = ss.getSheets();
  var target = null;
  for (var i = 0; i < sheets.length; i++) {
    var n = sheets[i].getName();
    if (n.indexOf('Search Term') > -1) { target = sheets[i]; break; }
  }
  if (!target) return [];

  var lastRow = target.getLastRow();
  var lastCol = target.getLastColumn();
  if (lastRow < 3 || lastCol < 5) return [];

  var headers    = target.getRange(2, 1, 1, lastCol).getValues()[0];
  var rowsToRead = Math.min(limit, lastRow - 2);
  if (rowsToRead < 1) return [];

  var values = target.getRange(3, 1, rowsToRead, lastCol).getValues();

  function findIdx(name) {
    for (var c = 0; c < headers.length; c++) {
      var h = String(headers[c]).toLowerCase();
      if (h.indexOf(name.toLowerCase()) > -1) return c;
    }
    return -1;
  }
  var iTerm = findIdx('Search Term');
  var iCost = findIdx('Cost');
  var iImpr = findIdx('Impressions');
  var iClk  = findIdx('Clicks');
  var iConv = findIdx('Conversions');
  var iCv   = findIdx('Conv. Value');
  var iCmp  = findIdx('Campaign');

  var out = [];
  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    var rec = {
      term:        iTerm >= 0 ? row[iTerm] : '',
      campaign:    iCmp  >= 0 ? row[iCmp]  : '',
      cost:        iCost >= 0 ? pf(row[iCost]) : 0,
      impressions: iImpr >= 0 ? pf(row[iImpr]) : 0,
      clicks:      iClk  >= 0 ? pf(row[iClk])  : 0,
      conversions: iConv >= 0 ? pf(row[iConv]) : 0,
      convValue:   iCv   >= 0 ? pf(row[iCv])   : 0,
    };
    if (rec.term) out.push(rec);
  }
  return out;
}

// ============================================================
// DRIVE CONTEXT
// ============================================================
function loadAIContext(folderId) {
  var folder = DriveApp.getFolderById(folderId);
  var files  = folder.getFiles();

  var systemPrompt = '';
  var pieces = [];

  while (files.hasNext()) {
    var f     = files.next();
    var name  = f.getName();
    var lower = name.toLowerCase();
    if (!(lower.indexOf('.txt') > -1 || lower.indexOf('.md') > -1)) continue;

    var content;
    try {
      content = f.getBlob().getDataAsString('UTF-8');
    } catch (e) {
      Logger.log('UYARI: ' + name + ' okunamadı: ' + e.message);
      continue;
    }

    if (lower === 'system_prompt.txt' || lower === 'system_prompt.md') {
      systemPrompt = content.trim();
    } else {
      pieces.push('[' + name + ']\n' + content.trim());
    }
  }

  return {
    systemPrompt: systemPrompt,
    projectFiles: pieces.join('\n\n'),
  };
}

// ============================================================
// PROMPT İNŞASI
// ============================================================
function buildSystemPrompt(clientSystemPrompt) {
  var defaults = ''
    + 'Sen kıdemli bir Google Ads performans analistisin.\n'
    + '\n'
    + 'DİL KURALI — KESİN:\n'
    + '- Analiste yönelik alanlar (evaluation_report, action_plan, good_things, bad_things, red_alerts): TÜRKÇE.\n'
    + '- Müşteriye gönderilecek alan (customer_message): İNGİLİZCE.\n'
    + '- Bu iki dili karıştırma; her alan kendi dilinde olmalı.\n'
    + '\n'
    + 'GÖREV: Sana verilen haftalık veriyi inceleyip yapılandırılmış bir rapor üreteceksin.\n'
    + 'Müşteri kendi geçmiş performansıyla kıyaslanacak; hesap içi hedefler ikinci plandadır.\n'
    + '\n'
    + 'ÇIKTI FORMATI: SADECE geçerli bir JSON nesnesi döndür. Başına/sonuna metin, açıklama, '
    + 'kod bloğu işareti (```) yazma. Şema:\n'
    + '{\n'
    + '  "evaluation_report": "string (TR) — 2-4 paragraflık akıcı değerlendirme",\n'
    + '  "action_plan":       ["string (TR)", ...] — somut, uygulanabilir aksiyonlar (3-7 adet),\n'
    + '  "good_things":       ["string (TR)", ...] — hafta içinde olumlu giden 3-6 nokta,\n'
    + '  "bad_things":        ["string (TR)", ...] — düşüş veya zayıf yönler 2-5 nokta,\n'
    + '  "red_alerts":        ["string (TR)", ...] — acil müdahale gereken kritik anomaliler (yoksa boş dizi),\n'
    + '  "customer_message":  "string (EN) — ready-to-send message to the client"\n'
    + '}\n'
    + '\n'
    + 'CUSTOMER MESSAGE RULES (English output) — STRICT:\n'
    + '- Write in natural, professional English. No Turkish words.\n'
    + '- Positive tone; frame issues constructively.\n'
    + '- NO emojis. NO exclamation marks.\n'
    + '- Warm, human, non-robotic voice.\n'
    + '- Benchmark against the client\'s own past performance; include concrete numbers (e.g. "cost was up 12% vs last week").\n'
    + '- Length: 4-7 sentences; keep it tight.\n'
    + '- End with a short natural closing about next week\'s focus (e.g. "Next week we will focus on...").\n'
    + '\n'
    + 'DEĞERLENDİRME / AKSİYON KURALLARI (Türkçe alanlar için):\n'
    + '- Sayıları yorumlarken WoW değişimi VE 4-haftalık baseline\'a göre değişimi ayrı belirt.\n'
    + '- Tek haftalık dalgalanmayı trend gibi sunma; net olduğunda söyle, belirsizse "izlenmeli" de.\n'
    + '- Aksiyonlar genel tavsiye değil, veriyle desteklenen somut adımlar olmalı.\n'
    + '- "red_alerts" sadece gerçek kritik durumlar için (örn. dönüşüm sıfırlanması, bütçe taşması, '
    + 'IS dramatik düşüş). Sıradan dalgalanmalar buraya GIRMEZ.\n';

  if (clientSystemPrompt) {
    return defaults + '\n[MÜŞTERİYE ÖZEL EK TALİMATLAR]\n' + clientSystemPrompt;
  }
  return defaults;
}

function buildUserMessage(p) {
  var sym = p.currencySym;
  var lines = [];

  lines.push('Müşteri: ' + p.clientName);
  lines.push('Para birimi: ' + p.currency);
  lines.push('');

  if (p.projectFiles) {
    lines.push('=== MÜŞTERİYE ÖZEL CONTEXT (Drive\'dan) ===');
    lines.push(p.projectFiles);
    lines.push('');
  }

  lines.push('=== HAFTA TANIMLARI ===');
  lines.push('Bu Hafta            : ' + p.ranges.current.startDate + ' → ' + p.ranges.current.endDate);
  lines.push('Geçen Hafta (WoW)   : ' + p.ranges.lastWeek.startDate + ' → ' + p.ranges.lastWeek.endDate);
  lines.push('4-Haftalık Baseline : ' + p.ranges.baseline4w.startDate + ' → ' + p.ranges.baseline4w.endDate);
  lines.push('Not: Baseline 28 gündür; aşağıda haftalık denkliğe ölçeklenmiş hali "Baseline (haftalık)" olarak verildi.');
  lines.push('');

  lines.push('=== HESAP METRİKLERİ ===');
  lines.push(formatMetricsTable_(p.metrics, sym));
  lines.push('');

  if (p.topCampaigns && p.topCampaigns.length) {
    lines.push('=== TOP ' + p.topCampaigns.length + ' KAMPANYA (Bu Hafta — cost desc) ===');
    lines.push(formatCampaignTable_(p.topCampaigns, sym));
    lines.push('');
  }

  if (p.topSearchTerms && p.topSearchTerms.length) {
    lines.push('=== TOP SEARCH TERMS (Dashboard\'dan) ===');
    lines.push(formatSearchTermTable_(p.topSearchTerms, sym));
    lines.push('');
  }

  lines.push('Lütfen yukarıdaki sistem talimatındaki JSON şemasında raporu üret. Sadece JSON döndür.');
  return lines.join('\n');
}

function formatMetricsTable_(m, sym) {
  function row(label, cur, last, base) {
    var dWoW  = pctChange(cur, last);
    var dBase = pctChange(cur, base);
    return label.padEnd(22) +
      ' | cur=' + fmtNum(cur) +
      ' | wow=' + fmtNum(last) + ' (' + fmtPct(dWoW) + ')' +
      ' | base/wk=' + fmtNum(base) + ' (' + fmtPct(dBase) + ')';
  }
  var c = m.current, l = m.lastWeek, b = m.baselineWeekly;
  return [
    row('Cost (' + sym + ')',    c.cost,        l.cost,        b.cost),
    row('Impressions',           c.impressions, l.impressions, b.impressions),
    row('Clicks',                c.clicks,      l.clicks,      b.clicks),
    row('CTR',                   c.ctr,         l.ctr,         b.ctr),
    row('Avg CPC (' + sym + ')', c.avgCpc,      l.avgCpc,      b.avgCpc),
    row('Conversions',           c.conversions, l.conversions, b.conversions),
    row('CPA (' + sym + ')',     c.cpa,         l.cpa,         b.cpa),
    row('Conv. Rate',            c.convRate,    l.convRate,    b.convRate),
    row('Conv. Value (' + sym + ')', c.convValue, l.convValue, b.convValue),
    row('ROAS',                  c.roas,        l.roas,        b.roas),
    row('Search IS',             c.searchIs,    l.searchIs,    b.searchIs),
    row('Lost IS (Budget)',      c.lostIsBudget,l.lostIsBudget,b.lostIsBudget),
    row('Lost IS (Rank)',        c.lostIsRank,  l.lostIsRank,  b.lostIsRank),
  ].join('\n');
}

function formatCampaignTable_(rows, sym) {
  var out = ['name | type | cost (' + sym + ') | clicks | conv | convValue | cpa | roas'];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    out.push(r.name + ' | ' + r.type + ' | ' + fmtNum(r.cost) + ' | ' +
      fmtNum(r.clicks) + ' | ' + fmtNum(r.conversions) + ' | ' + fmtNum(r.convValue) +
      ' | ' + fmtNum(r.cpa) + ' | ' + fmtNum(r.roas));
  }
  return out.join('\n');
}

function formatSearchTermTable_(rows, sym) {
  var out = ['term | campaign | cost (' + sym + ') | clicks | conv'];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    out.push(r.term + ' | ' + r.campaign + ' | ' + fmtNum(r.cost) + ' | ' +
      fmtNum(r.clicks) + ' | ' + fmtNum(r.conversions));
  }
  return out.join('\n');
}

// ============================================================
// CLAUDE API
// ============================================================
// Koşum içi cache; aynı batch içindeki N client için tek Config Sheet okuması yeter.
var _cachedAnthropicKey = null;

// Anahtar arama sırası:
//   1) PropertiesService (setApiKey ile yazılmışsa) — hızlı
//   2) Config Sheet 'claude_api_key' kolonu (ilk müşteri satırı) — fallback
function getAnthropicApiKey() {
  if (_cachedAnthropicKey) return _cachedAnthropicKey;

  var key = PropertiesService.getScriptProperties().getProperty(PROP_API_KEY);
  if (key) {
    _cachedAnthropicKey = key;
    Logger.log('API key PropertiesService\'ten okundu (prefix: ' + key.substring(0, 10) + '..., len: ' + key.length + ')');
    return key;
  }

  try {
    var ss     = SpreadsheetApp.openById(CONFIG_SHEET_ID);
    var sheet  = ss.getSheets()[0];
    var lastCol = sheet.getLastColumn();
    var lastRow = sheet.getLastRow();
    if (lastCol > 0 && lastRow >= 2) {
      var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
      for (var c = 0; c < headers.length; c++) {
        if (String(headers[c]).trim().toLowerCase() === 'claude_api_key') {
          var v = String(sheet.getRange(2, c + 1).getValue()).trim();
          if (v) {
            _cachedAnthropicKey = v;
            Logger.log('API key Config Sheet\'ten okundu (prefix: ' + v.substring(0, 10) + '..., len: ' + v.length + ')');
            return v;
          }
          Logger.log('UYARI: claude_api_key kolonu bulundu ama 2. satırdaki hücre boş.');
          break;
        }
      }
    }
  } catch (e) {
    Logger.log('UYARI: Config Sheet\'ten claude_api_key okunamadı: ' + e.message);
  }

  throw new Error('Anthropic API anahtarı bulunamadı. Config Sheet\'te "claude_api_key" kolonuna yaz ya da editor\'da setApiKey(\'sk-ant-...\') çalıştır.');
}

// Editor'da bir kerelik manuel olarak çalıştırılır:
//   setApiKey('sk-ant-...');
function setApiKey(key) {
  PropertiesService.getScriptProperties().setProperty(PROP_API_KEY, key);
  Logger.log('ANTHROPIC_API_KEY kaydedildi.');
}

function clearApiKey() {
  PropertiesService.getScriptProperties().deleteProperty(PROP_API_KEY);
  Logger.log('ANTHROPIC_API_KEY silindi.');
}

function callClaude(systemMsg, userMsg) {
  var apiKey = getAnthropicApiKey();

  var payload = {
    model:      ANTHROPIC_MODEL,
    max_tokens: ANTHROPIC_MAX_TOK,
    system:     systemMsg,
    messages:   [{ role: 'user', content: userMsg }],
  };
  var options = {
    method:             'post',
    contentType:        'application/json',
    muteHttpExceptions: true,
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    payload: JSON.stringify(payload),
  };

  var maxAttempts = 3;
  var lastErr = '';
  var fatal   = false;
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      var resp = UrlFetchApp.fetch(ANTHROPIC_API_URL, options);
      var code = resp.getResponseCode();
      var body = resp.getContentText();

      if (code >= 200 && code < 300) {
        var parsed = JSON.parse(body);
        var text   = extractClaudeText_(parsed);
        var json   = tryParseJson_(text);
        if (json) return json;

        // JSON parse başarısızsa bir kez "sadece JSON" hatırlatmasıyla retry
        if (attempt === 1) {
          Logger.log('JSON parse başarısız, retry hatırlatmasıyla deneniyor...');
          payload.messages.push({ role: 'assistant', content: text });
          payload.messages.push({ role: 'user', content: 'Yanıtın JSON olarak parse edilemedi. Lütfen SADECE geçerli JSON nesnesi olarak yeniden döndür; başka hiçbir metin yazma.' });
          options.payload = JSON.stringify(payload);
          continue;
        }
        return { _raw: text, _parseError: true };
      }

      lastErr = 'HTTP ' + code + ': ' + body.slice(0, 500);
      Logger.log('Claude API attempt ' + attempt + ' failed: ' + lastErr);

      // 4xx (auth/quota/billing) genelde retry'da düzelmez; 5xx ve 429 retry'lanabilir
      if (code >= 400 && code < 500 && code !== 429) {
        fatal = true;
      }
    } catch (e) {
      lastErr = e.message;
      Logger.log('Claude API attempt ' + attempt + ' exception: ' + lastErr);
    }
    if (fatal) break;
    Utilities.sleep(1500 * attempt);
  }
  throw new Error('Claude API ' + (fatal ? 'kalıcı hata' : maxAttempts + ' denemeden sonra başarısız') + ': ' + lastErr);
}

function extractClaudeText_(parsed) {
  if (!parsed || !parsed.content || !parsed.content.length) return '';
  var out = [];
  for (var i = 0; i < parsed.content.length; i++) {
    var c = parsed.content[i];
    if (c.type === 'text' && c.text) out.push(c.text);
  }
  return out.join('\n').trim();
}

function tryParseJson_(text) {
  if (!text) return null;
  var cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  var first = cleaned.indexOf('{');
  var last  = cleaned.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  var slice = cleaned.slice(first, last + 1);
  try {
    return JSON.parse(slice);
  } catch (e) {
    return null;
  }
}

function notifyOnFailure_(client, errorMsg) {
  if (!client.emailRecipient) return;
  try {
    MailApp.sendEmail({
      to:      client.emailRecipient,
      subject: '[Weekly AI Report] HATA — ' + client.clientName,
      body:    'Weekly AI Report scripti ' + client.clientName +
               ' için başarısız oldu.\n\nHata: ' + errorMsg +
               '\n\nBu hafta için rapor üretilmedi; eski rapor (varsa) korundu.',
    });
  } catch (e) {
    Logger.log('UYARI: Hata email\'i gönderilemedi: ' + e.message);
  }
}

// ============================================================
// CLIENT TAB — BÖLÜM YAZICILAR
// ============================================================
function writeSection_(sheet, row, cols, title, body, bgColor, hdrColor, monospace) {
  // Header
  sheet.getRange(row, 1, 1, cols).merge()
    .setValue(title)
    .setBackground(hdrColor)
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setFontSize(11)
    .setHorizontalAlignment('left')
    .setVerticalAlignment('middle')
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  sheet.setRowHeight(row, 28);
  row++;

  // Body
  var bodyRange = sheet.getRange(row, 1, 1, cols).merge()
    .setValue(body || '')
    .setBackground(bgColor)
    .setFontColor('#212121')
    .setVerticalAlignment('top')
    .setHorizontalAlignment('left')
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);
  if (monospace) bodyRange.setFontFamily('Roboto Mono');

  // İçerik yüksekliği — kabaca
  var lines       = String(body || '').split('\n').length;
  var charPerLine = 80;
  var approxLines = Math.max(lines, Math.ceil(String(body || '').length / charPerLine));
  sheet.setRowHeight(row, Math.min(Math.max(approxLines * 18 + 12, 60), 600));
  row++;
  return row;
}

function writeListSection_(sheet, row, cols, title, items, numbered, bgColor, hdrColor) {
  sheet.getRange(row, 1, 1, cols).merge()
    .setValue(title)
    .setBackground(hdrColor)
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setFontSize(11)
    .setHorizontalAlignment('left')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(row, 28);
  row++;

  var arr = Array.isArray(items) ? items : (items ? [String(items)] : []);
  if (!arr.length) arr = ['(boş)'];

  for (var i = 0; i < arr.length; i++) {
    var prefix = numbered ? (i + 1) + '. ' : '• ';
    var text   = prefix + String(arr[i]);
    sheet.getRange(row, 1, 1, cols).merge()
      .setValue(text)
      .setBackground(bgColor)
      .setVerticalAlignment('top')
      .setHorizontalAlignment('left')
      .setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);
    var approxLines = Math.max(1, Math.ceil(text.length / 110));
    sheet.setRowHeight(row, Math.min(approxLines * 20 + 8, 200));
    row++;
  }
  return row;
}

function writeMetricsBlock_(sheet, row, cols, ranges, metrics) {
  sheet.getRange(row, 1, 1, cols).merge()
    .setValue('Hafta Karşılaştırması — ' + ranges.current.startDate + ' → ' + ranges.current.endDate)
    .setBackground(COLORS.sectionHdr)
    .setFontColor('#000000')
    .setFontWeight('bold')
    .setFontSize(11)
    .setHorizontalAlignment('left')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(row, 28);
  row++;

  var sym = CONFIG.currencySymbol;
  var headers = ['Metrik', 'Bu Hafta', 'Geçen Hafta', 'WoW Δ%', 'Baseline (haftalık)', 'Baseline Δ%', ''];
  sheet.getRange(row, 1, 1, cols)
    .setValues([headers])
    .setBackground(COLORS.banner)
    .setFontColor(COLORS.bannerText)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(row, 26);
  row++;

  var c = metrics.current, l = metrics.lastWeek, b = metrics.baselineWeekly;
  var defs = [
    { label: 'Cost ('         + sym + ')', cur: c.cost,         last: l.cost,         base: b.cost,         betterUp: false, fmt: 'money' },
    { label: 'Impressions',                  cur: c.impressions,  last: l.impressions,  base: b.impressions,  betterUp: true,  fmt: 'int' },
    { label: 'Clicks',                       cur: c.clicks,       last: l.clicks,       base: b.clicks,       betterUp: true,  fmt: 'int' },
    { label: 'CTR',                          cur: c.ctr,          last: l.ctr,          base: b.ctr,          betterUp: true,  fmt: 'pct' },
    { label: 'Avg CPC ('     + sym + ')',  cur: c.avgCpc,       last: l.avgCpc,       base: b.avgCpc,       betterUp: false, fmt: 'money' },
    { label: 'Conversions',                  cur: c.conversions,  last: l.conversions,  base: b.conversions,  betterUp: true,  fmt: 'num2' },
    { label: 'CPA ('         + sym + ')',  cur: c.cpa,          last: l.cpa,          base: b.cpa,          betterUp: false, fmt: 'money' },
    { label: 'Conv. Rate',                   cur: c.convRate,     last: l.convRate,     base: b.convRate,     betterUp: true,  fmt: 'pct' },
    { label: 'Conv. Value (' + sym + ')',  cur: c.convValue,    last: l.convValue,    base: b.convValue,    betterUp: true,  fmt: 'money' },
    { label: 'ROAS',                         cur: c.roas,         last: l.roas,         base: b.roas,         betterUp: true,  fmt: 'num2' },
    { label: 'Search IS',                    cur: c.searchIs,     last: l.searchIs,     base: b.searchIs,     betterUp: true,  fmt: 'pct' },
    { label: 'Lost IS (Budget)',             cur: c.lostIsBudget, last: l.lostIsBudget, base: b.lostIsBudget, betterUp: false, fmt: 'pct' },
    { label: 'Lost IS (Rank)',               cur: c.lostIsRank,   last: l.lostIsRank,   base: b.lostIsRank,   betterUp: false, fmt: 'pct' },
  ];

  var values = [];
  var deltaCells = [];

  for (var i = 0; i < defs.length; i++) {
    var d = defs[i];
    var dWoW  = pctChange(d.cur, d.last);
    var dBase = pctChange(d.cur, d.base);
    values.push([
      d.label,
      formatVal(d.cur,  d.fmt, sym),
      formatVal(d.last, d.fmt, sym),
      fmtPct(dWoW),
      formatVal(d.base, d.fmt, sym),
      fmtPct(dBase),
      '',
    ]);
    deltaCells.push({ rowOffset: i, col: 4, val: dWoW,  betterUp: d.betterUp });
    deltaCells.push({ rowOffset: i, col: 6, val: dBase, betterUp: d.betterUp });
  }

  var startRow = row;
  sheet.getRange(startRow, 1, values.length, cols)
    .setValues(values)
    .setVerticalAlignment('middle');

  // Zebra
  for (var r = 0; r < values.length; r++) {
    sheet.getRange(startRow + r, 1, 1, cols)
      .setBackground(r % 2 === 0 ? COLORS.rowOdd : COLORS.rowEven);
  }

  // Δ renklendirmesi
  for (var k = 0; k < deltaCells.length; k++) {
    var dc = deltaCells[k];
    var color = deltaColor(dc.val, dc.betterUp);
    if (color) {
      sheet.getRange(startRow + dc.rowOffset, dc.col).setBackground(color);
    }
  }

  // Hizalama: 1. sütun sol, kalanları sağ
  sheet.getRange(startRow, 1, values.length, 1).setHorizontalAlignment('left');
  sheet.getRange(startRow, 2, values.length, cols - 1).setHorizontalAlignment('right');

  return startRow + values.length;
}

function writeTopCampaignsBlock_(sheet, row, cols, campaigns) {
  sheet.getRange(row, 1, 1, cols).merge()
    .setValue('Top Kampanyalar (Bu Hafta — referans)')
    .setBackground(COLORS.sectionHdr)
    .setFontWeight('bold')
    .setHorizontalAlignment('left')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(row, 26);
  row++;

  var sym = CONFIG.currencySymbol;
  var headers = ['Kampanya', 'Tip', 'Cost (' + sym + ')', 'Clicks', 'Conv', 'Conv Value', 'ROAS'];
  sheet.getRange(row, 1, 1, cols)
    .setValues([headers])
    .setBackground(COLORS.banner)
    .setFontColor(COLORS.bannerText)
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  row++;

  var data = [];
  for (var i = 0; i < campaigns.length; i++) {
    var c = campaigns[i];
    data.push([
      c.name,
      c.type,
      formatVal(c.cost,        'money', sym),
      formatVal(c.clicks,      'int',   sym),
      formatVal(c.conversions, 'num2',  sym),
      formatVal(c.convValue,   'money', sym),
      formatVal(c.roas,        'num2',  sym),
    ]);
  }
  if (data.length) {
    sheet.getRange(row, 1, data.length, cols).setValues(data);
    for (var r = 0; r < data.length; r++) {
      sheet.getRange(row + r, 1, 1, cols)
        .setBackground(r % 2 === 0 ? COLORS.rowOdd : COLORS.rowEven);
    }
    sheet.getRange(row, 1, data.length, 1).setHorizontalAlignment('left');
    sheet.getRange(row, 2, data.length, cols - 1).setHorizontalAlignment('right');
    row += data.length;
  }
  return row;
}

// ============================================================
// MANUEL KURULUM — CONFIG SHEET KOLONLARI
// ============================================================
// Editor'dan tek seferlik çalıştırılır. Eksik AI kolonlarını
// (ai_enabled, ai_drive_folder_id) Config Sheet'in ilk tab'ına ekler.
// Mevcut satırlardaki ai_enabled hücresine güvenli default (FALSE) yazar.
function setupConfigSheet() {
  Logger.log('=== Config Sheet kurulumu ===');
  var ss;
  try {
    ss = SpreadsheetApp.openById(CONFIG_SHEET_ID);
  } catch (e) {
    Logger.log('HATA: Config Sheet açılamadı (CONFIG_SHEET_ID kontrol et): ' + e.message);
    return;
  }

  var sheet   = ss.getSheets()[0];
  var lastCol = sheet.getLastColumn();
  var lastRow = sheet.getLastRow();
  if (lastCol < 1 || lastRow < 1) {
    Logger.log('HATA: Config Sheet tamamen boş. Önce header satırı + müşteri satırlarını gir.');
    return;
  }

  var headers  = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var existing = headers.map(function(h) { return String(h).trim().toLowerCase(); });

  // Önce zorunlu mevcut kolonları kontrol et (uyarı için)
  var coreRequired = ['secret_key', 'client_name', 'client_account_id'];
  var missingCore  = [];
  for (var i = 0; i < coreRequired.length; i++) {
    if (existing.indexOf(coreRequired[i]) === -1) missingCore.push(coreRequired[i]);
  }
  if (missingCore.length) {
    Logger.log('UYARI: Temel kolonlar eksik: ' + missingCore.join(', '));
    Logger.log('Bu kolonlar diğer scriptlerin de ihtiyacı; manuel eklemek gerekebilir.');
  }

  // AI'a özgü yeni kolonları ekle
  var aiRequired = ['ai_enabled', 'ai_drive_folder_id'];
  var added      = [];
  for (var j = 0; j < aiRequired.length; j++) {
    var name = aiRequired[j];
    if (existing.indexOf(name) !== -1) continue;

    lastCol++;
    sheet.getRange(1, lastCol)
      .setValue(name)
      .setFontWeight('bold')
      .setBackground('#FFE082');
    added.push(name + ' → sütun ' + columnLetter_(lastCol));

    // ai_enabled için: tüm mevcut satırlara default FALSE
    if (name === 'ai_enabled' && lastRow > 1) {
      var fill = [];
      for (var r = 0; r < lastRow - 1; r++) fill.push(['FALSE']);
      sheet.getRange(2, lastCol, lastRow - 1, 1).setValues(fill);
    }
  }

  if (!added.length) {
    Logger.log('Tüm AI kolonları zaten mevcut. Yapılacak: aktif müşteri satırlarında');
    Logger.log('  ai_enabled = TRUE   ve   ai_drive_folder_id = <Drive klasör ID>');
    return;
  }

  Logger.log('Eklenen kolonlar:');
  for (var k = 0; k < added.length; k++) Logger.log('  • ' + added[k]);
  Logger.log('');
  Logger.log('Sıradaki manuel adımlar:');
  Logger.log('  1) Aktif edilecek her müşteri satırında ai_enabled = TRUE yap.');
  Logger.log('  2) Aynı satırda ai_drive_folder_id hücresine Drive klasör ID\'sini yaz.');
  Logger.log('     (Klasör URL\'sinde /folders/ sonrası kısım.)');
  Logger.log('  3) Klasörün içine en az system_prompt.txt yerleştir.');
  Logger.log('  4) Sonra: setApiKey(\'sk-ant-...\') ve runMainNow().');
}

// Sütun indeksi (1-bazlı) → A, B, ..., Z, AA, AB ...
function columnLetter_(col) {
  var s = '';
  while (col > 0) {
    var r = (col - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    col = Math.floor((col - 1) / 26);
  }
  return s;
}

// ============================================================
// MANUEL DEBUG — TEK MÜŞTERİ
// ============================================================
// Editor'da: runForClient('SECRET_KEY')
function runForClient(secretKey) {
  Logger.log('=== Manuel tek-müşteri koşumu: ' + secretKey + ' ===');
  var client = findClientBySecretKey_(secretKey);
  if (!client) {
    Logger.log('HATA: secret_key \"' + secretKey + '\" Config Sheet\'te bulunamadı veya ai_enabled=FALSE.');
    return;
  }
  var ranges = getWeeklyDateRanges();
  var ss = getOrCreateMasterSheet();
  ensureMasterTabs(ss, ranges);

  var startMs = Date.now();
  try {
    processClient_(client, ss, ranges);
    var dur = Math.round((Date.now() - startMs) / 1000);
    appendMasterRunLog_(ss, client, 'OK (manual)', dur, '');
    Logger.log('Tamamlandı (' + dur + 's). Master: ' + ss.getUrl());
  } catch (e) {
    var dur2 = Math.round((Date.now() - startMs) / 1000);
    appendMasterRunLog_(ss, client, 'ERROR (manual)', dur2, e.message);
    Logger.log('HATA: ' + e.message);
  }
}

// ============================================================
// FORMATÇI / YARDIMCI
// ============================================================
function pf(v) { return parseFloat(v) || 0; }
function mic(v) { return (parseFloat(v) || 0) / 1e6; }

function pctChange(cur, prev) {
  if (!prev) return cur ? Infinity : 0;
  return (cur - prev) / prev;
}

function fmtNum(v) {
  if (v === null || v === undefined || isNaN(v)) return '0';
  if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString('en-US');
  if (Math.abs(v) >= 10)   return (Math.round(v * 10) / 10).toString();
  return (Math.round(v * 100) / 100).toString();
}

function fmtPct(d) {
  if (d === Infinity)  return 'n/a (0\'dan)';
  if (d === -Infinity) return 'n/a';
  if (isNaN(d))         return '-';
  var pct  = d * 100;
  var sign = pct > 0 ? '+' : '';
  return sign + (Math.round(pct * 10) / 10) + '%';
}

function formatVal(v, kind, sym) {
  if (kind === 'money') return sym + fmtNum(v);
  if (kind === 'pct')   return (Math.round(v * 1000) / 10) + '%';
  if (kind === 'int')   return fmtNum(Math.round(v));
  if (kind === 'num2')  return (Math.round(v * 100) / 100).toString();
  return String(v);
}

function deltaColor(d, betterUp) {
  if (d === 0 || isNaN(d) || d === Infinity || d === -Infinity) return null;
  var threshold = 0.03;
  if (Math.abs(d) < threshold) return null;
  var positive = (d > 0) === betterUp;
  return positive ? COLORS.posDelta : COLORS.negDelta;
}

function paintDeltaCell(sheet, row, col, d, betterUp) {
  var color = deltaColor(d, betterUp);
  if (color) sheet.getRange(row, col).setBackground(color);
}

function nowIso_() {
  var d = new Date();
  return d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0') + ' '
    + String(d.getHours()).padStart(2, '0') + ':'
    + String(d.getMinutes()).padStart(2, '0') + ':'
    + String(d.getSeconds()).padStart(2, '0');
}
