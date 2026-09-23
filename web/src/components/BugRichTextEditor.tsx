import { BoldOutlined, DeleteOutlined, ItalicOutlined, OrderedListOutlined, PaperClipOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { Button, Space, Tooltip } from "antd";
import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent } from "react";

export interface BugEditorImage {
  id: string;
  file: File;
  url: string;
}

export function BugRichTextEditor(props: {
  initialHtml: string;
  onChange: (html: string) => void;
  onAddImages: (files: File[]) => BugEditorImage[];
}) {
  const editorRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectionRef = useRef<Range | null>(null);
  const [selectedImageId, setSelectedImageId] = useState<string>();

  useEffect(() => {
    if (!editorRef.current) return;
    editorRef.current.innerHTML = props.initialHtml;
    props.onChange(editorRef.current.innerHTML);
    // The draft is loaded once when the editor mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emitChange = () => props.onChange(editorRef.current?.innerHTML || "");

  const rememberSelection = () => {
    const selection = window.getSelection();
    if (selection?.rangeCount && editorRef.current?.contains(selection.anchorNode)) {
      selectionRef.current = selection.getRangeAt(0).cloneRange();
    }
  };

  const restoreSelection = () => {
    editorRef.current?.focus();
    if (!selectionRef.current) return;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(selectionRef.current);
  };

  const runCommand = (command: string) => {
    restoreSelection();
    document.execCommand(command);
    rememberSelection();
    emitChange();
  };

  const insertImages = (files: File[]) => {
    const images = props.onAddImages(files);
    if (!images.length) return;
    restoreSelection();
    const html = images.map((image) => `<p><img src="${image.url}" data-bug-image-id="${image.id}" alt="截图"></p>`).join("");
    document.execCommand("insertHTML", false, html);
    rememberSelection();
    emitChange();
  };

  const pasteImages = (event: ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item, index) => {
        const file = item.getAsFile();
        return file ? new File([file], `screenshot-${Date.now()}-${index + 1}.${file.type.split("/")[1] || "png"}`, { type: file.type }) : null;
      })
      .filter((file): file is File => Boolean(file));
    if (!files.length) return;
    event.preventDefault();
    rememberSelection();
    insertImages(files);
  };

  const removeSelectedImage = () => {
    if (!selectedImageId || !editorRef.current) return;
    editorRef.current.querySelectorAll("img[data-bug-image-id]").forEach((image) => {
      if (image.getAttribute("data-bug-image-id") === selectedImageId) image.remove();
    });
    setSelectedImageId(undefined);
    emitChange();
  };

  return (
    <div className="bug-rich-editor">
      <div className="bug-rich-toolbar">
        <Space size={4}>
          <Tooltip title="加粗"><Button size="small" type="text" icon={<BoldOutlined />} onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand("bold")} /></Tooltip>
          <Tooltip title="斜体"><Button size="small" type="text" icon={<ItalicOutlined />} onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand("italic")} /></Tooltip>
          <Tooltip title="编号列表"><Button size="small" type="text" icon={<OrderedListOutlined />} onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand("insertOrderedList")} /></Tooltip>
          <Tooltip title="项目列表"><Button size="small" type="text" icon={<UnorderedListOutlined />} onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand("insertUnorderedList")} /></Tooltip>
          <input ref={fileInputRef} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => { insertImages(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          <Tooltip title="插入截图，也可直接粘贴"><Button size="small" type="text" icon={<PaperClipOutlined />} onMouseDown={(event) => event.preventDefault()} onClick={() => fileInputRef.current?.click()} /></Tooltip>
          <Tooltip title="移除选中的截图"><Button size="small" type="text" danger disabled={!selectedImageId} icon={<DeleteOutlined />} onMouseDown={(event) => event.preventDefault()} onClick={removeSelectedImage} /></Tooltip>
        </Space>
      </div>
      <article
        ref={editorRef}
        className="bug-rich-content"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-label="Bug 正文"
        aria-multiline="true"
        onInput={emitChange}
        onPaste={pasteImages}
        onKeyUp={rememberSelection}
        onMouseUp={rememberSelection}
        onClick={(event) => {
          const target = event.target as HTMLElement;
          setSelectedImageId(target.tagName === "IMG" ? target.getAttribute("data-bug-image-id") || undefined : undefined);
          if (target.closest("a")) event.preventDefault();
        }}
      />
    </div>
  );
}
