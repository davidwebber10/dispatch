import { SearchSelect, type SearchSelectOption } from './SearchSelect';
import { useIsMobile } from '../../hooks/useIsMobile';

export type SelectOption = SearchSelectOption;

/**
 * The app's one dropdown for form fields (2026-11-07): no native `<select>` anywhere, so every
 * picker looks and behaves the same in every theme and on every phone. It is SearchSelect with the
 * search box only past 8 options; a short list takes focus itself (arrows, Enter, a letter jumps).
 * The phone gets the large size (40px trigger, 44px rows). Plugins get it as `d.ui.Select`.
 */
export function Select({ searchable, size, ...props }: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  id?: string;
  searchable?: boolean;
  placeholder?: string;
  size?: 'md' | 'lg';
  style?: React.CSSProperties;
  disabled?: boolean;
}) {
  const isMobile = useIsMobile();
  return <SearchSelect {...props} size={size ?? (isMobile ? 'lg' : 'md')} searchable={searchable ?? props.options.length > 8} />;
}
