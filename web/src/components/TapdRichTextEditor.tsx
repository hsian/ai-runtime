import {
  BoldOutlined,
  DeleteOutlined,
  ItalicOutlined,
  OrderedListOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import { Button, Space, Typography } from "antd";
import { useEffect, useRef, useState } from "react";

import type { TapdImageOption } from "../types";

function hydrateHtml(html: string, images: TapdImageOption[]): string {
  const documentNode = new DOMParser().parseFromString(`<div id="tapd-editor-root">${html}</div>`, "text/html");
  const root = documentNode.getElementById("tapd-editor-root");
  if (!root) return "";
  const imagesByIndex = new Map(images.map((image) => [image.sourceIndex, image]));
  root.querySelectorAll("img").forEach((element) => {
    const sourceIndex = Number.parseInt(element.getAttribute("data-source-index") || "", 10);
    const image = imagesByIndex.get(sourceIndex);
    if (!image) {
      const unavailable = documentNode.createElement("span");
      unavailable.className = "tapd-editor-image-missing";
      unavailable.textContent = Number.isInteger(sourceIndex) ? `[配图${sourceIndex}加载失败或已删除]` : "[图片不可用]";
      element.replaceWith(unavailable);
      return;
    }
    element.setAttribute("src", image.previewUrl);
    element.setAttribute("alt", `TAPD 配图${sourceIndex}`);
    element.removeAttribute("style");
    element.removeAttribute("class");
  });
  return root.innerHTML;
}

export function TapdRichTextEditor(props: {
  initialHtml: string;
  images: TapdImageOption[];
  onChange: (html: string) => void;
}) {
  const editorRef = useRef<HTMLElement>(null);
  const selectedImageRef = useRef<HTMLImageElement | null>(null);
  const [selectedImageIndex, setSelectedImageIndex] = useState<number>();

  const emitChange = () => {
    props.onChange(editorRef.current?.innerHTML || "");
  };

  const selectImage = (image?: HTMLImageElement) => {
    selectedImageRef.current?.classList.remove("is-selected");
    selectedImageRef.current = image ?? null;
    image?.classList.add("is-selected");
    const sourceIndex = Number.parseInt(image?.dataset.sourceIndex || "", 10);
    setSelectedImageIndex(Number.isInteger(sourceIndex) ? sourceIndex : undefined);
  };

  const deleteSelectedImage = () => {
    const image = selectedImageRef.current;
    if (!image) return;
    image.remove();
    selectImage(undefined);
    emitChange();
  };

  useEffect(() => {
    if (!editorRef.current) return;
    editorRef.current.innerHTML = hydrateHtml(props.initialHtml, props.images);
    selectImage(undefined);
    emitChange();
    // initialHtml changes only when a TAPD item is loaded or reopened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.initialHtml, props.images]);

  const runCommand = (command: string) => {
    editorRef.current?.focus();
    document.execCommand(command);
    emitChange();
  };

  return (
    <div className="tapd-rich-editor">
      <div className="tapd-editor-toolbar">
        <Space size={4} wrap>
          <Button size="small" icon={<BoldOutlined />} onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand("bold")}>粗体</Button>
          <Button size="small" icon={<ItalicOutlined />} onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand("italic")}>斜体</Button>
          <Button size="small" icon={<UnorderedListOutlined />} onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand("insertUnorderedList")}>无序列表</Button>
          <Button size="small" icon={<OrderedListOutlined />} onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand("insertOrderedList")}>有序列表</Button>
          <Button size="small" danger icon={<DeleteOutlined />} disabled={!selectedImageIndex} onClick={deleteSelectedImage}>
            {selectedImageIndex ? `删除配图${selectedImageIndex}` : "删除选中图片"}
          </Button>
        </Space>
        <Typography.Text type="secondary">修改只用于本次任务，不会回写 TAPD</Typography.Text>
      </div>
      <article
        ref={editorRef}
        className="tapd-editor-content"
        contentEditable
        suppressContentEditableWarning
        onInput={emitChange}
        onClick={(event) => {
          const target = event.target as HTMLElement;
          const image = target.tagName === "IMG" ? target as HTMLImageElement : undefined;
          selectImage(image);
          if (target.closest("a")) event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (selectedImageRef.current && (event.key === "Delete" || event.key === "Backspace")) {
            event.preventDefault();
            deleteSelectedImage();
          }
        }}
      />
      <Typography.Text className="tapd-editor-hint" type="secondary">
        可直接修改正文和评论；点击图片后按 Delete/Backspace 可删除。只有正文中保留的图片会随任务发送。
      </Typography.Text>
    </div>
  );
}
