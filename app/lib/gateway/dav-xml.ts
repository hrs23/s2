// WebDAV XML generation utilities

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SUPPORTED_LOCK = `<D:supportedlock>
          <D:lockentry>
            <D:lockscope><D:exclusive/></D:lockscope>
            <D:locktype><D:write/></D:locktype>
          </D:lockentry>
          <D:lockentry>
            <D:lockscope><D:shared/></D:lockscope>
            <D:locktype><D:write/></D:locktype>
          </D:lockentry>
        </D:supportedlock>`;

export function propfindResponse(opts: {
  href: string;
  isCollection: boolean;
  size: number;
  lastModified: string;
  contentType?: string;
  contentVersion?: number;
}): string {
  const displayName = opts.href.split("/").filter(Boolean).pop() || "";
  const etag =
    opts.contentVersion != null && opts.contentVersion > 0
      ? `<D:getetag>"${opts.contentVersion}"</D:getetag>`
      : "";

  if (opts.isCollection) {
    return `<D:response>
      <D:href>${escapeXml(opts.href)}</D:href>
      <D:propstat>
        <D:prop>
          <D:resourcetype><D:collection/></D:resourcetype>
          <D:displayname>${escapeXml(displayName)}</D:displayname>
          <D:getlastmodified>${opts.lastModified}</D:getlastmodified>
          ${etag}
          <D:lockdiscovery/>
          ${SUPPORTED_LOCK}
        </D:prop>
        <D:status>HTTP/1.1 200 OK</D:status>
      </D:propstat>
    </D:response>`;
  }

  const contentType = opts.contentType ?? "application/octet-stream";

  return `<D:response>
    <D:href>${escapeXml(opts.href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype/>
        <D:displayname>${escapeXml(displayName)}</D:displayname>
        <D:getcontentlength>${opts.size}</D:getcontentlength>
        <D:getcontenttype>${escapeXml(contentType)}</D:getcontenttype>
        ${etag}
        <D:getlastmodified>${opts.lastModified}</D:getlastmodified>
        <D:lockdiscovery/>
        ${SUPPORTED_LOCK}
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
}

export function multiStatusXml(responses: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
${responses.join("\n")}
</D:multistatus>`;
}

export function lockResponseXml(href: string, token: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<D:prop xmlns:D="DAV:">
  <D:lockdiscovery>
    <D:activelock>
      <D:locktype><D:write/></D:locktype>
      <D:lockscope><D:exclusive/></D:lockscope>
      <D:depth>infinity</D:depth>
      <D:owner/>
      <D:timeout>Second-3600</D:timeout>
      <D:locktoken><D:href>urn:uuid:${token}</D:href></D:locktoken>
      <D:lockroot><D:href>${escapeXml(href)}</D:href></D:lockroot>
    </D:activelock>
  </D:lockdiscovery>
</D:prop>`;
}
