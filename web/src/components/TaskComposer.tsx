import { CloseOutlined, LinkOutlined, PaperClipOutlined, SendOutlined } from "@ant-design/icons";
import { App as AntApp, Button, Image, Input, Select, Switch, Tag, Tooltip } from "antd";
import type { ClipboardEvent } from "react";
import { useEffect, useRef, useState } from "react";

import type { AgentProvider, TapdContext, TapdImageOption } from "../types";

export function TaskComposer(props: {
  value: string;
  modifyCode: boolean;
  agentProvider: AgentProvider;
  files: File[];
  tapdContext?: TapdContext;
  tapdImages: TapdImageOption[];
  submitting: boolean;
  onChange: (value: string) => void;
  onModifyCodeChange: (value: boolean) => void;
  onAgentProviderChange: (value: AgentProvider) => void;
  onFilesChange: (files: File[]) => void;
  onTapdImagesChange: (images: TapdImageOption[]) => void;
  onOpenTapd: () => void;
  onRemoveTapd: () => void;
  onSubmit: () => void;
}) {
  const { message } = AntApp.useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const [filePreviews, setFilePreviews] = useState<Array<{ file: File; url: string }>>([]);
  const tapdImageCount = props.tapdImages.length;
  useEffect(() => {
    const previews = props.files.map((file) => ({ file, url: URL.createObjectURL(file) }));
    setFilePreviews(previews);
    return () => previews.forEach((preview) => URL.revokeObjectURL(preview.url));
  }, [props.files]);
  const addImages = (images: File[]): number => {
    const accepted = images.filter((file) => file.type.startsWith("image/"));
    if (accepted.length === 0) return 0;
    props.onFilesChange([...props.files, ...accepted]);
    return accepted.length;
  };
  const addFiles = (list: FileList | null) => {
    addImages(Array.from(list ?? []));
    if (inputRef.current) inputRef.current.value = "";
  };
  const pasteImages = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (images.length === 0) return;
    event.preventDefault();
    const accepted = addImages(images);
    if (accepted > 0) message.success(`已粘贴 ${accepted} 张图片`);
  };

  return (
    <div className="composer-card">
      {(props.files.length > 0 || props.tapdContext) && (
        <div className="composer-context">
          {props.tapdContext && (
            <Tag closable onClose={props.onRemoveTapd} color="blue">
              TAPD · {props.tapdContext.title}{tapdImageCount ? ` · ${tapdImageCount} 张配图` : ""}
            </Tag>
          )}
          {(props.tapdImages.length > 0 || filePreviews.length > 0) && (
            <div className="composer-image-list">
              {props.tapdImages.map((image) => (
                <div className="composer-image" key={`tapd-${image.sourceIndex}`}>
                  <Image src={image.previewUrl} alt={`TAPD 配图${image.sourceIndex}`} />
                  <span>TAPD 配图{image.sourceIndex}</span>
                  <Button
                    className="composer-image-remove"
                    type="text"
                    danger
                    size="small"
                    icon={<CloseOutlined />}
                    aria-label={`移除 TAPD 配图${image.sourceIndex}`}
                    onClick={() => props.onTapdImagesChange(props.tapdImages.filter((item) => item.sourceIndex !== image.sourceIndex))}
                  />
                </div>
              ))}
              {filePreviews.map((preview, index) => (
                <div className="composer-image" key={`${preview.file.name}-${index}`}>
                  <Image src={preview.url} alt={preview.file.name || `图片${index + 1}`} />
                  <span>{preview.file.name || `图片${index + 1}`}</span>
                  <Button
                    className="composer-image-remove"
                    type="text"
                    danger
                    size="small"
                    icon={<CloseOutlined />}
                    aria-label={`移除${preview.file.name || `图片${index + 1}`}`}
                    onClick={() => props.onFilesChange(props.files.filter((_, itemIndex) => itemIndex !== index))}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <Input.TextArea
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        onPaste={pasteImages}
        autoSize={{ minRows: 2, maxRows: 7 }}
        placeholder="描述问题或修改需求，涉及页面时请附上路径……"
        onPressEnter={(event) => {
          if (!event.shiftKey) {
            event.preventDefault();
            props.onSubmit();
          }
        }}
      />
      <div className="composer-toolbar">
        <div className="composer-tools">
          <Select
            className="agent-provider-select"
            size="small"
            value={props.agentProvider}
            options={[
              { label: "默认", value: "claude" },
              { label: "Codex", value: "codex" },
            ]}
            popupMatchSelectWidth={false}
            onChange={props.onAgentProviderChange}
          />
          <input ref={inputRef} hidden type="file" accept="image/*" multiple onChange={(event) => addFiles(event.target.files)} />
          <Tooltip title="选择图片，也可以在输入框中直接 Ctrl+V 粘贴截图">
            <Button className="composer-tool-button" type="text" icon={<PaperClipOutlined />} onClick={() => inputRef.current?.click()}>图片</Button>
          </Tooltip>
          <Tooltip title="关联 TAPD 需求、任务或缺陷">
            <Button className="composer-tool-button" type="text" icon={<LinkOutlined />} onClick={props.onOpenTapd}>TAPD</Button>
          </Tooltip>
          <span className="mode-switch"><Switch size="small" checked={props.modifyCode} onChange={props.onModifyCodeChange} /> 修改代码</span>
        </div>
        <Button
          type="primary"
          icon={<SendOutlined />}
          loading={props.submitting}
          disabled={!props.value.trim()}
          onClick={props.onSubmit}
        >
          发送
        </Button>
      </div>
    </div>
  );
}
