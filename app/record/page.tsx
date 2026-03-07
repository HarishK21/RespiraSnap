import RecordPageClient from "./RecordPageClient";

type RecordPageProps = {
  searchParams?: {
    mode?: string;
  };
};

export default function RecordPage({ searchParams }: RecordPageProps) {
  const mode = typeof searchParams?.mode === "string" ? searchParams.mode : "breathing";
  return <RecordPageClient mode={mode} />;
}
