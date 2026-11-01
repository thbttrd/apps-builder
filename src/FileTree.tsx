import { useState } from 'react'

/** A directory has `children`; a file has null. Nothing else distinguishes them. */
type TreeNode = { name: string; path: string; children: TreeNode[] | null }

/**
 * The server sends a flat sorted list — the same one the agent's list_files returns.
 * Folding it into a tree is fifteen lines here and would be a second shape to keep in
 * sync there, so the server stays dumb.
 */
function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = []
  for (const path of paths) {
    const parts = path.split('/')
    let level = root
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i] ?? ''
      const leaf = i === parts.length - 1
      let node = level.find((n) => n.name === name && (n.children === null) === leaf)
      if (!node) {
        node = { name, path: parts.slice(0, i + 1).join('/'), children: leaf ? null : [] }
        level.push(node)
      }
      const children = node.children
      if (children) level = children
    }
  }
  return sorted(root)
}

/** Directories first, then alphabetical — the order every file tree has taught people. */
function sorted(nodes: TreeNode[]): TreeNode[] {
  nodes.sort(
    (a, b) =>
      (a.children === null ? 1 : 0) - (b.children === null ? 1 : 0) || a.name.localeCompare(b.name),
  )
  for (const n of nodes) if (n.children) sorted(n.children)
  return nodes
}

export default function FileTree({
  files,
  selected,
  onSelect,
}: {
  files: string[]
  selected: string | null
  onSelect: (path: string) => void
}) {
  // Collapsed, not expanded: a generated project is a dozen files, so everything open
  // is the useful default and this set stays empty until someone closes something.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    })

  if (files.length === 0) return <p className="p-3 text-sm opacity-50">no files</p>

  return (
    <ul className="p-1 text-sm">
      {buildTree(files).map((node) => (
        <Branch
          key={node.path}
          node={node}
          depth={0}
          selected={selected}
          collapsed={collapsed}
          onToggle={toggle}
          onSelect={onSelect}
        />
      ))}
    </ul>
  )
}

function Branch({
  node,
  depth,
  selected,
  collapsed,
  onToggle,
  onSelect,
}: {
  node: TreeNode
  depth: number
  selected: string | null
  collapsed: ReadonlySet<string>
  onToggle: (path: string) => void
  onSelect: (path: string) => void
}) {
  // py-2 everywhere: these rows are tapped on a phone, where anything under 44px is a
  // coin toss. Indent is inline because the depth is data, not one of six fixed classes.
  const pad = { paddingLeft: `${depth * 0.75 + 0.5}rem` }

  if (node.children) {
    const shut = collapsed.has(node.path)
    return (
      <li>
        <button
          onClick={() => onToggle(node.path)}
          aria-expanded={!shut}
          style={pad}
          className="w-full text-left py-2 pr-2 rounded-md flex items-center gap-1.5 opacity-70 hover:opacity-100 hover:bg-current/5"
        >
          <span className="shrink-0 text-xs opacity-60">{shut ? '▸' : '▾'}</span>
          <span className="truncate">{node.name}</span>
        </button>
        {!shut && (
          <ul>
            {node.children.map((child) => (
              <Branch
                key={child.path}
                node={child}
                depth={depth + 1}
                selected={selected}
                collapsed={collapsed}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <li>
      <button
        onClick={() => onSelect(node.path)}
        aria-current={node.path === selected ? 'true' : undefined}
        style={pad}
        className={`w-full text-left py-2 pr-2 rounded-md truncate ${
          node.path === selected ? 'bg-current/10' : 'opacity-80 hover:opacity-100 hover:bg-current/5'
        }`}
      >
        {node.name}
      </button>
    </li>
  )
}
