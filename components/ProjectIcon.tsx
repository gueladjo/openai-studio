import React from 'react';
import {
  BookOpen,
  BriefcaseBusiness,
  Code2,
  Folder,
  FlaskConical,
  PenLine,
  Stethoscope,
  type LucideIcon
} from 'lucide-react';
import type { ProjectIcon } from '../types';

export const PROJECT_ICON_OPTIONS: ReadonlyArray<{
  value: ProjectIcon;
  label: string;
}> = [
  { value: 'folder', label: 'Folder' },
  { value: 'briefcase', label: 'Briefcase' },
  { value: 'code', label: 'Code' },
  { value: 'book', label: 'Book' },
  { value: 'research', label: 'Research' },
  { value: 'writing', label: 'Writing' },
  { value: 'health', label: 'Health' }
];

const PROJECT_ICONS: Record<ProjectIcon, LucideIcon> = {
  folder: Folder,
  briefcase: BriefcaseBusiness,
  code: Code2,
  book: BookOpen,
  research: FlaskConical,
  writing: PenLine,
  health: Stethoscope
};

export const ProjectIconGlyph: React.FC<{
  icon: ProjectIcon;
  size?: number;
  className?: string;
}> = ({ icon, size = 16, className }) => {
  const Icon = PROJECT_ICONS[icon];
  return <Icon size={size} className={className} aria-hidden="true" />;
};
