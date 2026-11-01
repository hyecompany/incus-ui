// SPDX-FileCopyrightText: © 2026 Hye Ararat contributors
// SPDX-License-Identifier: Apache-2.0

import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

/** Footer link back to the method picker. */
export function AnotherMethodLink({
	onClick,
	children = "Use another sign-in method",
}: {
	/** Runs before navigating, e.g. to clear a resume key. */
	onClick?: () => void;
	children?: ReactNode;
}) {
	return (
		<Link
			to="/auth"
			search={{ choose: true }}
			onClick={onClick}
			className="underline-offset-4 hover:text-foreground hover:underline"
		>
			{children}
		</Link>
	);
}
