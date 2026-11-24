import { useState } from "react";

import type { DraftAttachment } from "./draft-attachments";
import "./draft-attachments.css";
import { useImageViewer, type ViewerImageItem } from "./ImageViewer";
import { ICON_SM, Icon } from "./ui";
import { fileIconText, formatBytes } from "./web/phone-images";

export function DraftAttachments({
  attachments,
  onRemove,
}: {
  attachments: readonly DraftAttachment[];
  onRemove: (index: number) => void;
}) {
  const openViewer = useImageViewer();
  const [brokenUrls, setBrokenUrls] = useState<Set<string>>(() => new Set());
  const openAt = (targetUrl: string, opener: HTMLElement) => {
    const items: ViewerImageItem[] = [];
    let initialIndex = 0;
    for (const att of attachments) {
      if (!att.mimeType.startsWith("image/") || brokenUrls.has(att.url)) continue;
      if (att.url === targetUrl) initialIndex = items.length;
      items.push({
        src: att.url,
        filename: att.name,
        alt: att.name,
        blob: new Blob([att.data as BlobPart], { type: att.mimeType }),
      });
    }
    openViewer(items, initialIndex, opener);
  };
  return (
    <div className="atts">
      {attachments.map((attachment, index) => {
        const isImg = attachment.mimeType.startsWith("image/");
        const broken = brokenUrls.has(attachment.url);
        return (
          <span className="thumb2" key={`${attachment.name}:${index}`}>
            {isImg ? (
              broken ? (
                <img src={attachment.url} alt={attachment.name} />
              ) : (
                <button
                  type="button"
                  className="thumb2-open"
                  aria-label={attachment.name}
                  onClick={(event) => {
                    openAt(attachment.url, event.currentTarget);
                  }}
                >
                  <img
                    src={attachment.url}
                    alt={attachment.name}
                    onError={() => {
                      setBrokenUrls((prev) => {
                        const next = new Set(prev);
                        next.add(attachment.url);
                        return next;
                      });
                    }}
                  />
                </button>
              )
            ) : (
              <span className="ficon" aria-hidden="true">
                {fileIconText(attachment.name)}
              </span>
            )}
            <span className="fname">{attachment.name}</span>
            <span className="fsize">{formatBytes(attachment.data.byteLength)}</span>
            <button
              type="button"
              className="x"
              aria-label={`移除 ${attachment.name}`}
              onClick={() => {
                onRemove(index);
              }}
            >
              <Icon name="close" size={ICON_SM} />
            </button>
          </span>
        );
      })}
    </div>
  );
}
