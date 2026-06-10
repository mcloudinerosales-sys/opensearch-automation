//psc-recon-devices-match-missing2
import 'dotenv/config';
import { Client } from '@opensearch-project/opensearch';
import ExcelJS from 'exceljs';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import fs from 'fs';

// Mas safe na pagbasa ng credentials para sa GitHub Actions
const creds = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));

const client = new Client({
  node: process.env.OPENSEARCH_URL,
  auth: {
    username: process.env.OPENSEARCH_USERNAME,
    password: process.env.OPENSEARCH_PASSWORD,
  },
  ssl: { rejectUnauthorized: false },
});

const INDEX = process.env.INDEX_NAME;
const LOCAL_FILE = 'input.xlsx';
const BATCH_SIZE = 2000; 

// --- GOOGLE AUTH ---
const auth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.readonly'
  ],
});

// --- HELPER FUNCTIONS ---
function normalize(value) {
  if (value === 0) return 0;
  if (value === null || value === undefined || String(value).trim() === '') {
    return null; 
  }
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

// --- MAIN PROCESSOR (Bulk Version) ---
async function processData(rows, sourceName) {
  let batch = [];
  let totalProcessed = 0;
  
  const headers = rows[0]; 

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const obj = {};
    
    headers.forEach((key, index) => {
      if (key) {
        const cleanKey = key.toLowerCase().replace(/\s+/g, '_');
        let val = normalize(row[index]);

        if (val === null) {
          // PROTECTION LOGIC:
          // Kung ang field ay nade-detect ni OpenSearch bilang Date (snapshot_id, ingested, timestamp),
          // HUWAG lagyan ng hyphen '-' para hindi ma-reject ang buong row.
          const isSpecialField = cleanKey.includes('timestamp') || 
                                 cleanKey.includes('date') || 
                                 cleanKey.includes('@') || 
                                 cleanKey.includes('ingested') ||
                                 cleanKey.includes('id'); 
          
          if (!isSpecialField) {
            obj[cleanKey] = '-'; 
          }
        } else {
          obj[cleanKey] = val;
        }
      }
    });

    obj.source_type = sourceName;
    obj.sync_timestamp = new Date().toISOString();

    // Bulk format lines
    batch.push({ index: { _index: INDEX } });
    batch.push(obj);
    
    totalProcessed++;

    if (batch.length >= BATCH_SIZE * 2) {
      const result = await client.bulk({ refresh: true, body: batch });
      
      if (result.body.errors) {
        // I-log lang natin ang unang error para sa debugging
        const errorSample = result.body.items.find(item => item.index && item.index.error);
        if (errorSample) {
          console.error(`⚠️ May error sa batch:`, JSON.stringify(errorSample.index.error, null, 2));
        }
      }

      batch = [];
      console.log(`⏳ Progress [${sourceName}]: ${totalProcessed} records sent...`);
    }
  }

  // I-upload ang huling batch
  if (batch.length > 0) {
    await client.bulk({ refresh: true, body: batch });
  }
  console.log(`✅ Finished ${sourceName}: ${totalProcessed} records processed.`);
}

async function run() {
  try {
    console.log(`🚀 Starting Fresh Sync for: ${INDEX}...`);

    // DAGDAG ITO: Buburahin ang lumang index para hindi mag-duplicate ang data
    try {
      await client.indices.delete({ index: INDEX });
      console.log(`🗑️ Index [${INDEX}] deleted successfully.`);
    } catch (e) {
      console.log(`ℹ️ Index not found or already deleted, proceeding...`);
    }

    // ... (ituloy ang rest ng code mo dito)

    if (fs.existsSync(LOCAL_FILE)) {
      console.log('📂 Local file found. Reading input.xlsx...');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(LOCAL_FILE);
      
      const sheets = ['MATCH', 'MISSING'];
      for (const name of sheets) {
        const ws = workbook.getWorksheet(name);
        if (ws) {
          const rows = [];
          ws.eachRow(row => rows.push(row.values.slice(1)));
          await processData(rows, name);
        }
      }
    } else {
      console.log('🌐 Local file not found. Fetching from Google Sheets...');
      const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
      await doc.loadInfo();
      
      const sheetsToProcess = ['MATCH', 'MISSING'];
      for (const name of sheetsToProcess) {
        const sheet = doc.sheetsByTitle[name];
        if (sheet) {
          console.log(`📖 Loading sheet: ${name}...`);
          const rows = await sheet.getRows(); 
          const rawRows = [sheet.headerValues, ...rows.map(r => r._rawData)];
          await processData(rawRows, name);
        }
      }
    }
    console.log("🏁 ALL DATA SYNCED SUCCESSFULLY!");
  } catch (error) {
    console.error('❌ Final Error Check:', error.message);
  }
}

run();
