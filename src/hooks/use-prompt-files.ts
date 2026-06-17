import * as React from "react";
import { notifyUnknownError } from "@/lib/notify";
import { getShellWorkspacePolicy } from "@/runtime/shell-policy";

type UploadResponse = { ok?: boolean; value?: unknown; error?: string };

export function getPromptFiles(files: FileList | File[]): File[] {
  return Array.from(files);
}

function insertAtSelection(textarea: HTMLTextAreaElement | null, value: string, insertion: string) {
  const start = textarea?.selectionStart ?? value.length;
  const end = textarea?.selectionEnd ?? value.length;
  const before = value.slice(0, start);
  const after = value.slice(end);
  const prefix = before.length === 0 || /\s$/.test(before) ? "" : " ";
  const nextInsertion = `${prefix}${insertion}`;
  return {
    value: `${before}${nextInsertion}${after}`,
    cursor: before.length + nextInsertion.length,
  };
}

export function usePromptFiles({
  disabled,
  value,
  setValue,
  serverUrl,
  textareaRef,
}: {
  disabled: boolean;
  value: string;
  setValue: React.Dispatch<React.SetStateAction<string>>;
  serverUrl?: string | null;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [isDragging, setIsDragging] = React.useState(false);
  const [isUploading, setIsUploading] = React.useState(false);
  const [uploadProgress, setUploadProgress] = React.useState<number | null>(null);
  const appendUploadedPaths = React.useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      const mentions = paths.map((path) => `@${path}`).join(" ");
      const inserted = insertAtSelection(textareaRef.current, value, `${mentions} `);
      setValue(inserted.value);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(inserted.cursor, inserted.cursor);
      });
    },
    [setValue, textareaRef, value],
  );

  const uploadFiles = React.useCallback(
    async (files: File[]) => {
      setIsUploading(true);
      setUploadProgress(0);
      const form = new FormData();
      for (const file of files) form.append("files", file, file.name);

      const headers = new Headers();
      const token =
        serverUrl?.trim() || !window.electronAPI?.backendToken
          ? getShellWorkspacePolicy().configuredWebWorkspace?.authToken
          : window.electronAPI.backendToken;
      if (token) headers.set("authorization", `Bearer ${token}`);

      const base =
        serverUrl?.trim().replace(/\/+$/, "") ||
        window.electronAPI?.backendUrl?.trim().replace(/\/+$/, "") ||
        "";
      const paths = await new Promise<string[]>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${base}/api/fs/upload`);
        for (const [key, headerValue] of headers) xhr.setRequestHeader(key, headerValue);
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable)
            setUploadProgress(Math.round((event.loaded / event.total) * 100));
        };
        xhr.onload = () => {
          let body: UploadResponse | null = null;
          try {
            body = JSON.parse(xhr.responseText || "null") as UploadResponse | null;
          } catch {
            reject(
              new Error(
                `Upload endpoint returned non-JSON response (${xhr.status}) from ${xhr.responseURL || `${base}/api/fs/upload`}`,
              ),
            );
            return;
          }
          if (xhr.status < 200 || xhr.status >= 300 || !body?.ok || !Array.isArray(body.value)) {
            reject(new Error(body?.error || "Failed to upload file"));
            return;
          }
          resolve(body.value.filter((item): item is string => typeof item === "string"));
        };
        xhr.onerror = () => reject(new Error("Failed to upload file"));
        xhr.send(form);
      });
      appendUploadedPaths(paths);
      setUploadProgress(100);
      setIsUploading(false);
    },
    [appendUploadedPaths, serverUrl],
  );

  const appendFiles = React.useCallback(
    async (files: FileList | File[]) => {
      if (disabled || isUploading) return;
      const promptFiles = getPromptFiles(files);
      if (promptFiles.length === 0) return;
      try {
        await uploadFiles(promptFiles);
      } catch (error) {
        notifyUnknownError(error);
        setIsUploading(false);
        setUploadProgress(null);
      }
    },
    [disabled, isUploading, uploadFiles],
  );

  const handleFileChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      if (disabled) return;
      if (event.target.files) {
        void appendFiles(event.target.files);
      }
      event.target.value = "";
    },
    [appendFiles, disabled],
  );

  const handleDragOver = React.useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (disabled) return;
      setIsDragging(true);
    },
    [disabled],
  );

  const handleDragLeave = React.useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = React.useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (disabled) return;
      setIsDragging(false);
      if (event.dataTransfer.files.length > 0) {
        void appendFiles(event.dataTransfer.files);
      }
    },
    [appendFiles, disabled],
  );

  const handlePaste = React.useCallback(
    (event: React.ClipboardEvent) => {
      if (disabled) return;
      const files: File[] = [];
      for (const item of Array.from(event.clipboardData.items)) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
      if (files.length > 0) {
        event.preventDefault();
        void appendFiles(files);
      }
    },
    [appendFiles, disabled],
  );

  return {
    isDragging,
    isUploading,
    uploadProgress,
    uploadError: null,
    appendFiles,
    handleFileChange,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handlePaste,
  };
}
