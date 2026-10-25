const source = $('Normalize Jobs').first()?.json ?? {};
const tableItems = $input.all();

function text(value) {
  return value == null ? '' : String(value).trim();
}

function linkedInJobPathId(link, label) {
  if (
    typeof link !== 'string'
    || link !== link.trim()
    || /[\s\\\u0000-\u001f\u007f-\u009f]/u.test(link)
    || /%(?![0-9a-f]{2})/iu.test(link)
  ) {
    throw new Error(`${label} has an invalid link`);
  }

  for (const match of link.matchAll(/%([0-9a-f]{2})/giu)) {
    const byte = Number.parseInt(match[1], 16);
    if (byte < 0x20 || byte === 0x5c || byte === 0x7f) {
      throw new Error(`${label} has an unsafe percent-encoded character in its link`);
    }
  }

  if (!/^https:\/\//i.test(link)) {
    throw new Error(`${label} link must be a public LinkedIn HTTPS URL in /jobs/view/<job-id> form`);
  }
  const rest = link.slice('https://'.length);
  const suffixStart = rest.search(/[?#]/);
  const authorityAndPath = suffixStart === -1 ? rest : rest.slice(0, suffixStart);
  const slash = authorityAndPath.indexOf('/');
  if (slash <= 0) {
    throw new Error(`${label} link must be a public LinkedIn HTTPS URL in /jobs/view/<job-id> form`);
  }

  const authority = authorityAndPath.slice(0, slash);
  if (
    authority.includes('@')
    || authority.includes(':')
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*linkedin\.com$/i.test(authority)
  ) {
    throw new Error(`${label} link must use a public LinkedIn HTTPS authority`);
  }

  const path = authorityAndPath.slice(slash);
  const prefix = '/jobs/view/';
  if (!path.startsWith(prefix)) {
    throw new Error(`${label} link must be a LinkedIn job view URL`);
  }
  let slug = path.slice(prefix.length);
  if (slug.endsWith('/')) slug = slug.slice(0, -1);
  if (!slug || slug.includes('/')) {
    throw new Error(`${label} link must contain one non-empty job slug`);
  }

  const pathIdMatch = /(?:^|[-_])([0-9]+)$/.exec(slug);
  if (!pathIdMatch) {
    throw new Error(`${label} link does not end with a numeric job ID`);
  }
  return pathIdMatch[1];
}

function publicId(value, label) {
  const id = text(value);
  if (!/^[0-9]+$/.test(id)) {
    throw new Error(`${label} has an invalid id`);
  }
  return id;
}

function validateJob(job, index) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    throw new Error(`Normalized job ${index} is not an object`);
  }
  const id = publicId(job.id, `Normalized job ${index}`);
  if (typeof job.title !== 'string' || !job.title.trim()) {
    throw new Error(`Normalized job ${index} is missing title`);
  }
  if (typeof job.url !== 'string') {
    throw new Error(`Normalized job ${index} is missing link`);
  }
  const pathId = linkedInJobPathId(job.url, `Normalized job ${index}`);
  if (pathId !== id) {
    throw new Error(`Normalized job ${index} link job ID does not match its id`);
  }
  return id;
}

if (!Array.isArray(source.jobs)) {
  throw new Error('Normalize Jobs did not return a jobs array');
}

const existingIds = new Set();
tableItems.forEach((item, rowIndex) => {
  const row = item?.json ?? {};
  const values = Object.entries(row)
    .filter(([key]) => key !== 'row_number')
    .map(([, value]) => value);
  const rowIsEmpty = values.every((value) => value == null || text(value) === '');
  if (rowIsEmpty) return;
  if (row.id == null || text(row.id) === '') {
    const sheetRow = text(row.row_number) || String(rowIndex + 1);
    throw new Error(`Existing sheet row ${sheetRow} has data but no id`);
  }
  existingIds.add(publicId(row.id, 'Existing sheet row'));
});

const fetchedIds = new Set();
const newJobs = [];
let skippedExisting = 0;
let skippedBatchDuplicates = 0;

source.jobs.forEach((job, index) => {
  const id = validateJob(job, index);
  if (existingIds.has(id)) {
    skippedExisting += 1;
  } else if (fetchedIds.has(id)) {
    skippedBatchDuplicates += 1;
  } else {
    fetchedIds.add(id);
    newJobs.push(job);
  }
});

const summary = {
  runId: source.runId,
  datasetId: source.datasetId,
  actorSummary: source.actorSummary,
  coverage: source.coverage,
  fetchedCount: source.jobs.length,
  newCount: newJobs.length,
  skippedExisting,
  skippedBatchDuplicates,
  hasNewJobs: newJobs.length > 0,
};

return [{ json: { newJobs, summary, hasNewJobs: summary.hasNewJobs } }];
