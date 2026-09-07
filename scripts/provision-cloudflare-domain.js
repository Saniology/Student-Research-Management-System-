#!/usr/bin/env node

const args = parseArgs(process.argv.slice(2));

const requiredHostname = args.hostname || args.host;
const recordType = String(args.type || process.env.SPMS_DNS_RECORD_TYPE || 'CNAME').toUpperCase();
const recordContent = args.target || process.env.SPMS_DNS_TARGET;
const proxied = parseBoolean(args.proxied ?? process.env.SPMS_DNS_PROXIED, false);
const dryRun = Boolean(args['dry-run'] || args.dryRun);

if (args.help || args.h) {
  printHelp();
  process.exit(0);
}

main().catch((error) => {
  console.error(`ERROR ${error.message}`);
  process.exit(1);
});

async function main() {
  const hostname = normalizeHostname(requiredHostname);
  assertRecordType(recordType);
  if (!recordContent) throw new Error('Missing DNS target. Pass --target or set SPMS_DNS_TARGET.');

  const payload = {
    type: recordType,
    name: hostname,
    content: recordContent,
    ttl: proxied ? 1 : Number(args.ttl || process.env.SPMS_DNS_TTL || 300),
    proxied,
    comment: 'Provisioned for SPMS tenant routing',
  };

  console.log(`Tenant domain: ${hostname}`);
  console.log(`DNS record:    ${payload.type} ${payload.name} -> ${payload.content}`);
  console.log(`Cloudflare:    ${payload.proxied ? 'proxied' : 'DNS only'}`);
  console.log('');
  console.log('Add this domain to Admin Settings > Allowed Domains after DNS is created:');
  console.log(hostname);
  console.log('');
  console.log('SQL fallback for the owner:');
  console.log(
    `UPDATE institutions SET allowed_domains = array_append(array_remove(allowed_domains, '${hostname}'), '${hostname}') WHERE slug = '${sqlEscape(args.tenant || 'kasu')}';`,
  );

  if (dryRun) {
    console.log('');
    console.log('Dry run only. No Cloudflare changes were made.');
    return;
  }

  const token = process.env.CLOUDFLARE_API_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  if (!token || !zoneId) {
    throw new Error('Missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ZONE_ID. Use --dry-run to preview without credentials.');
  }

  const existing = await findDnsRecord(token, zoneId, hostname, recordType);
  const result = existing
    ? await updateDnsRecord(token, zoneId, existing.id, payload)
    : await createDnsRecord(token, zoneId, payload);

  console.log('');
  console.log(existing ? 'Updated Cloudflare DNS record.' : 'Created Cloudflare DNS record.');
  console.log(`Record ID: ${result.id}`);
}

async function findDnsRecord(token, zoneId, hostname, recordType) {
  const url = new URL(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`);
  url.searchParams.set('type', recordType);
  url.searchParams.set('name', hostname);
  const body = await cloudflareFetch(token, url, { method: 'GET' });
  return body.result?.[0] || null;
}

async function createDnsRecord(token, zoneId, payload) {
  const body = await cloudflareFetch(token, `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return body.result;
}

async function updateDnsRecord(token, zoneId, recordId, payload) {
  const body = await cloudflareFetch(token, `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  return body.result;
}

async function cloudflareFetch(token, url, options) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const message = body.errors?.map((error) => error.message).join('; ') || `Cloudflare request failed with ${res.status}`;
    throw new Error(message);
  }
  return body;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const [rawKey, inlineValue] = token.slice(2).split('=');
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = argv[index + 1];
    if (inlineValue !== undefined) {
      result[key] = inlineValue;
    } else if (next && !next.startsWith('--')) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
    result[rawKey] = result[key];
  }
  return result;
}

function normalizeHostname(value) {
  const hostname = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!hostname) throw new Error('Missing --hostname.');
  if (!/^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(hostname)) {
    throw new Error(`Invalid hostname: ${hostname}`);
  }
  return hostname;
}

function assertRecordType(value) {
  if (!['CNAME', 'A', 'AAAA'].includes(value)) {
    throw new Error('DNS record type must be CNAME, A, or AAAA.');
  }
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

function printHelp() {
  console.log(`
Usage:
  node scripts/provision-cloudflare-domain.js --hostname spms.school.edu --target cname.example.com --tenant kasu --dry-run

Environment for live Cloudflare changes:
  CLOUDFLARE_API_TOKEN   Token with DNS edit permission for the zone
  CLOUDFLARE_ZONE_ID     Cloudflare zone ID
  SPMS_DNS_TARGET        CNAME target or IP address

Optional:
  --type CNAME|A|AAAA
  --proxied true|false
  --ttl 300
`);
}
