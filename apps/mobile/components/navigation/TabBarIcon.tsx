import Ionicons from '@expo/vector-icons/Ionicons';
import { type ComponentProps } from 'react';

export function TabBarIcon({
  name,
  color,
  size = 28,
}: {
  name: ComponentProps<typeof Ionicons>['name'];
  color: string;
  size?: number;
}) {
  return <Ionicons name={name} size={size} color={color} />;
}
