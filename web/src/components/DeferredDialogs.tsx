import { Modal, Spin } from "antd";
import { lazy, Suspense, useState, type ComponentProps } from "react";
import type { CodeDiffModal as DiffComponent } from "./CodeDiffModal";
import type { ApiDocSearch as SearchComponent } from "./ApiDocSearch";

const Diff = lazy(() => import("./CodeDiffModal").then(module => ({ default: module.CodeDiffModal })));
const Search = lazy(() => import("./ApiDocSearch").then(module => ({ default: module.ApiDocSearch })));

// Keep dialog state after the first visit, without loading its code before then.
function useHasOpened(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return open || opened;
}

function LoadingDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Modal open={open} title="正在加载…" footer={null} onCancel={onClose}><Spin /></Modal>;
}

export function CodeDiffModal(props: ComponentProps<typeof DiffComponent>) {
  const opened = useHasOpened(props.open);
  return opened ? <Suspense fallback={<LoadingDialog {...props} />}><Diff {...props} /></Suspense> : null;
}

export function ApiDocSearch(props: ComponentProps<typeof SearchComponent>) {
  const opened = useHasOpened(props.open);
  return opened ? <Suspense fallback={<LoadingDialog {...props} />}><Search {...props} /></Suspense> : null;
}
