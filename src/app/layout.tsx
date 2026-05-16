import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "10 Mile Chris Pipeline",
  description: "Email campaign automation pipeline",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
