import {
  AppWindow, Buildings, Calculator, ChartBar, ChartLine, ChatCircleDots, ChatsCircle, Compass, Database, FileText, Gear,
  House, Kanban, Lightning, Megaphone, Package, Robot, ShoppingCart, Sparkle, SquaresFour, Storefront, Table, Tag, Truck,
  Users, type Icon,
} from '@phosphor-icons/react';

/**
 * The OS app icons by Phosphor name (the `icon` of GET /api/dispatch/shell). A name not in this list
 * gets the generic app glyph. Add a name here when OS starts sending a new one.
 */
const ICONS: Record<string, Icon> = {
  AppWindow, Buildings, Calculator, ChartBar, ChartLine, ChatCircleDots, ChatsCircle, Compass, Database, FileText, Gear,
  House, Kanban, Lightning, Megaphone, Package, Robot, ShoppingCart, Sparkle, SquaresFour, Storefront, Table, Tag, Truck, Users,
};

export function osIcon(name: string | undefined): Icon {
  return (name && ICONS[name]) || AppWindow;
}

/** Dispatch's own icon in the switcher (the current app). */
export const PRODUCT_ICON: Icon = Robot;
