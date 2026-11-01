// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { Button } from "@/components/ui/button";

export interface DownloadableFile {
	name: string;
	content: string | Uint8Array;
	mimeType: string;
	/** What the file is for, in a few words. */
	description: string;
}

export function downloadFile(file: DownloadableFile) {
	const part: BlobPart =
		typeof file.content === "string"
			? file.content
			: new Uint8Array(file.content);
	const href = URL.createObjectURL(new Blob([part], { type: file.mimeType }));
	const link = document.createElement("a");
	link.href = href;
	link.download = file.name;
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(href), 1_000);
}

/** A list of files with individual and "Download all" buttons; reports what was saved. */
export function CertificateDownloads({
	files,
	downloaded,
	onDownloaded,
}: {
	files: DownloadableFile[];
	/** Names already downloaded, shown with a check mark. */
	downloaded: ReadonlySet<string>;
	onDownloaded: (names: string[]) => void;
}) {
	const save = (list: DownloadableFile[]) => {
		// Browsers may block several downloads from one click, so space them out.
		list.forEach((file, i) => {
			setTimeout(() => downloadFile(file), i * 250);
		});
		onDownloaded(list.map((file) => file.name));
	};
	return (
		<div className="flex flex-col gap-2">
			<ul className="flex flex-col divide-y rounded-lg border">
				{files.map((file) => {
					const done = downloaded.has(file.name);
					return (
						<li key={file.name} className="flex items-center gap-3 p-3">
							<div className="flex min-w-0 flex-1 flex-col">
								<span className="truncate font-mono text-[13px]">
									{file.name}
								</span>
								<span className="text-xs text-muted-foreground">
									{file.description}
								</span>
							</div>
							<Button
								type="button"
								variant={done ? "ghost" : "outline"}
								size="sm"
								onClick={() => save([file])}
								aria-label={`Download ${file.name}`}
							>
								{done ? (
									<span className="text-emerald-500">Saved</span>
								) : (
									"Download"
								)}
							</Button>
						</li>
					);
				})}
			</ul>
			<Button type="button" onClick={() => save(files)} className="self-start">
				Download all
			</Button>
		</div>
	);
}
