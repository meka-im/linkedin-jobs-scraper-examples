const response = $input.first()?.json ?? {};
const run = $('Assess Run Output').first()?.json ?? {};

let body = response.body !== undefined ? response.body : response;
if (typeof body === 'string') {
  try {
    body = JSON.parse(body);
  } catch {
    throw new Error(`Dataset ${run.datasetId ?? 'UNKNOWN'} did not return valid JSON`);
  }
}
if (!Array.isArray(body) && Array.isArray(body?.data)) {
  body = body.data;
}
if (!Array.isArray(body)) {
  throw new Error(`Dataset ${run.datasetId ?? 'UNKNOWN'} response must be an array`);
}

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

function requirePublicJob(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`Dataset item ${index} is not an object`);
  }
  const id = text(item.id);
  const title = text(item.title);
  const link = item.link;
  if (!/^[0-9]+$/.test(id)) {
    throw new Error(`Dataset item ${index} has an invalid id`);
  }
  if (!title) {
    throw new Error(`Dataset item ${index} is missing title`);
  }
  const pathId = linkedInJobPathId(link, `Dataset item ${index}`);
  if (pathId !== id) {
    throw new Error(`Dataset item ${index} link job ID does not match its id`);
  }
  return { id, title, link };
}

const firstSeenAt = new Date().toISOString();
const jobs = body.map((item, index) => {
  const publicJob = requirePublicJob(item, index);
  return {
    id: publicJob.id,
    title: publicJob.title,
    company: text(item.companyName),
    location: text(item.location),
    postedAt: text(item.postedAt),
    url: publicJob.link,
    salary: text(item.salary),
    employmentType: text(item.employmentType),
    seniority: text(item.seniorityLevel),
    firstSeenAt,
  };
});

return [{
  json: {
    jobs,
    runId: run.runId,
    datasetId: run.datasetId,
    status: run.status,
    count: run.count,
    sheetId: run.sheetId,
    sheetName: run.sheetName,
    actorSummary: run.actorSummary,
    coverage: run.coverage,
    fetchedCount: jobs.length,
  },
}];
