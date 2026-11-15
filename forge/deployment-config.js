// This fork's task service is served through the site's existing reverse proxy.
globalThis.FF_IMAGE_JOBS_BASE='/api/image-jobs';
globalThis.FF_IMAGE_JOB_HOSTS=['api.shuaiapi.com'];
// This origin was denied at preflight by the former service. Preserve its
// unacknowledged local placeholders outside the new service's active queue.
globalThis.FF_ARCHIVE_BLOCKED_IMAGE_JOBS=true;
