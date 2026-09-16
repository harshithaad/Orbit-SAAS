import { requireOrg } from "@/lib/org";
import { can } from "@/lib/permissions";
import { Card } from "@/components/ui";
import { NewProjectForm, ProjectRow } from "./client";

export const metadata = { title: "Projects" };

export default async function ProjectsPage({ params }: PageProps<"/app/[orgSlug]/projects">) {
  const { orgSlug } = await params;
  const ctx = await requireOrg(orgSlug);
  const projects = await ctx.db.project.findMany({ orderBy: { createdAt: "desc" } });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Projects</h1>
        <p className="text-sm text-zinc-500">{projects.length} in this organisation.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card className="p-0">
          <ul className="divide-y divide-zinc-100">
            {projects.map((p) => (
              <ProjectRow
                key={p.id}
                orgSlug={orgSlug}
                id={p.id}
                name={p.name}
                description={p.description}
                createdAt={p.createdAt.toISOString()}
                canDelete={can(ctx.role, "project:delete")}
              />
            ))}
            {projects.length === 0 && <li className="px-6 py-8 text-center text-sm text-zinc-500">No projects yet.</li>}
          </ul>
        </Card>
        {can(ctx.role, "project:create") && (
          <Card>
            <h2 className="mb-3 font-medium">New project</h2>
            <NewProjectForm orgSlug={orgSlug} />
          </Card>
        )}
      </div>
    </div>
  );
}
